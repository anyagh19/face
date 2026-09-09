import { Injectable, Inject, PLATFORM_ID, OnDestroy } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Observable, Subject } from 'rxjs';

import type {
  ProctoringFlag,
  ProctoringFlagType,
  ProctoringSeverity,
  FaceVerificationResult,
  IdentityVerificationResult,
  DetectionLogEntry
} from './procto.types';
import { ProctoringConfig, PROCTORING_CONFIG } from './procto.config';

export type { ProctoringConfig } from './procto.config';
export { PROCTORING_CONFIG, DEFAULT_PROCTORING_CONFIG } from './procto.config';
export * from './procto.types';

// =============================================================================
// Service
// =============================================================================

type FaceApiModule = any;
type CocoSsdModule = any;

@Injectable({ providedIn: 'root' })
export class ProctoringService implements OnDestroy {
  private faceapi: FaceApiModule = null;
  private cocoSsd: CocoSsdModule = null;
  private objectModel: any = null;
  private faceMatcherOptions: any = null;

  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;

  private readonly snapshotCanvas: HTMLCanvasElement | null;
  private readonly snapshotCtx: CanvasRenderingContext2D | null;

  private isRunning = false;
  private sessionToken = 0;

  private consecutiveNoFaceCount = 0;

  private registrationDescriptor: Float32Array | null = null;
  private registrationImgEl: HTMLImageElement | null = null;

  private identityCheckIntervalId: ReturnType<typeof setInterval> | null = null;

  public candidateId = 'unknown-candidate';
  public examId = 'unknown-exam';

  // ---------------------------------------------------------------------
  // Edge-tracking state. Each of these represents "is this problem
  // currently active?" so we can emit exactly ONE flag when it starts and
  // exactly ONE clear/restored flag when it ends, instead of re-firing on
  // every polling tick while the condition persists.
  // ---------------------------------------------------------------------
  private lastFaceState: 'face_detected' | 'no_face_detected' | null = null;
  private faceFlaggedMissing = false; // whether no_face_detected has actually been raised (post-debounce)
  private multiFaceActive = false;    // "extra person" signal from face detector
  private multiPersonObjActive = false; // "extra person" signal from object detector
  private objectActive = false;
  private identityMismatchActive = false;
  private tabHidden = false;
  private windowBlurred = false;

  private get personActive(): boolean {
    return this.multiFaceActive || this.multiPersonObjActive;
  }

  private readonly flagsSubject = new Subject<ProctoringFlag>();
  readonly flags$: Observable<ProctoringFlag> = this.flagsSubject.asObservable();

  /**
   * Unified, human-readable, console-style event stream. One entry per
   * meaningful state change (violation started, violation cleared, face
   * lost/found, tab switched/restored, etc.) — never a periodic heartbeat.
   * This is what a UI should bind to for an activity log.
   */
  private readonly logsSubject = new Subject<DetectionLogEntry>();
  readonly logs$: Observable<DetectionLogEntry> = this.logsSubject.asObservable();

  private readonly faceStatusSubject = new Subject<'face_detected' | 'no_face_detected'>();
  readonly faceStatus$ = this.faceStatusSubject.asObservable();

  private readonly visibilityHandler = () => {
    if (document.hidden) {
      this.tabHidden = true;
      this.emitFlag('tab_switched', 'medium', 'Exam tab was switched or minimized.');
    } else if (this.tabHidden) {
      this.tabHidden = false;
      this.emitFlag('tab_restored', 'low', 'Returned to the exam tab.');
    }
  };
  private readonly blurHandler = () => {
    if (!this.windowBlurred) {
      this.windowBlurred = true;
      this.emitFlag('window_lost_focus', 'medium', 'Exam window lost focus.');
    }
  };
  private readonly focusHandler = () => {
    if (this.windowBlurred) {
      this.windowBlurred = false;
      this.emitFlag('window_focus_restored', 'low', 'Exam window regained focus.');
    }
  };

  constructor(
    @Inject(PLATFORM_ID) private readonly platformId: Object,
    @Inject(PROCTORING_CONFIG) private readonly config: ProctoringConfig
  ) {
    if (isPlatformBrowser(this.platformId)) {
      this.snapshotCanvas = document.createElement('canvas');
      this.snapshotCtx = this.snapshotCanvas.getContext('2d');
    } else {
      this.snapshotCanvas = null;
      this.snapshotCtx = null;
    }
  }

  async initialize(): Promise<boolean> {
    if (!isPlatformBrowser(this.platformId)) {
      console.log('Proctoring skipped during SSR');
      return false;
    }

    if (this.faceapi && this.cocoSsd && this.objectModel) {
      return true;
    }

    try {
      const [faceApiModule, cocoSsdModule] = await Promise.all([
        import('@vladmandic/face-api'),
        import('@tensorflow-models/coco-ssd')
      ]);

      this.faceapi = faceApiModule;
      this.cocoSsd = cocoSsdModule;

      await this.loadModels();
      this.setupBrowserListeners();

      return true;
    } catch (error) {
      console.error('Failed to initialize AI modules:', error);
      return false;
    }
  }

  private async loadModels(): Promise<void> {
    if (!this.faceapi || !this.cocoSsd) {
      throw new Error('AI modules not initialized.');
    }

    await this.withRetry(() =>
      Promise.all([
        this.faceapi.nets.tinyFaceDetector.loadFromUri(this.config.modelUrl),
        this.faceapi.nets.faceLandmark68Net.loadFromUri(this.config.modelUrl),
        this.faceapi.nets.faceRecognitionNet.loadFromUri(this.config.modelUrl)
      ])
    );

    this.faceMatcherOptions = new this.faceapi.TinyFaceDetectorOptions({
      inputSize: 320,
      scoreThreshold: 0.5
    });

    this.objectModel = await this.withRetry(() => this.cocoSsd.load());
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (retries <= 0) throw err;
      await new Promise(resolve => setTimeout(resolve, 500));
      return this.withRetry(fn, retries - 1);
    }
  }

  async startCamera(videoElement: HTMLVideoElement): Promise<boolean> {
    if (!isPlatformBrowser(this.platformId)) return false;

    if (!window.isSecureContext) {
      console.error(
        'Camera access requires a secure context (HTTPS, or http://localhost). ' +
        `Current origin: ${window.location.origin}. getUserMedia is unavailable on plain ` +
        'HTTP for any host other than localhost/127.0.0.1 — this is a browser-enforced ' +
        'restriction, not something fixable in code.'
      );
      this.emitFlag('camera_error', 'high', 'Camera unavailable: page is not on a secure origin.');
      return false;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      console.error(
        'navigator.mediaDevices.getUserMedia is not available in this browser/context. ' +
        'This usually means: (a) an insecure context (see above), (b) a very old browser, ' +
        'or (c) the page is embedded in an iframe whose "allow" attribute does not include ' +
        '"camera", or whose parent site sends a Permissions-Policy header blocking camera access.'
      );
      this.emitFlag('camera_error', 'high', 'Camera API not available in this browser/context.');
      return false;
    }

    try {
      this.video = videoElement;
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });

      this.video.srcObject = this.stream;
      await this.video.play();
      return true;
    } catch (error) {
      const name = (error as DOMException)?.name;
      const reasons: Record<string, string> = {
        NotAllowedError: 'Permission was denied (by the user, or by a previous block that needs to be reset in browser site settings).',
        NotFoundError: 'No camera device was found on this machine.',
        NotReadableError: 'The camera is already in use by another application or browser tab.',
        OverconstrainedError: 'No camera satisfies the requested constraints (resolution/facingMode).',
        SecurityError: 'Blocked by a security policy (insecure context or Permissions-Policy).',
        AbortError: 'Camera access was aborted, possibly due to a hardware or OS-level issue.'
      };
      const reason = reasons[name ?? ''] ?? 'Unrecognized error.';
      console.error(`Unable to access camera [${name ?? 'UnknownError'}]: ${reason}`, error);
      this.emitFlag('camera_error', 'high', `Camera access failed: ${reason}`);
      return false;
    }
  }

  startDetection(): void {
    if (!isPlatformBrowser(this.platformId) || !this.faceapi || !this.video || this.isRunning) {
      return;
    }

    this.isRunning = true;
    const token = this.sessionToken;

    this.logsSubject.next({
      message: 'Live monitoring started.',
      severity: 'low',
      timestamp: new Date().toISOString()
    });

    this.scheduleLoop(token, () => this.detectFace(token), this.config.faceCheckIntervalMs);
    this.scheduleLoop(token, () => this.detectObjects(token), this.config.objectCheckIntervalMs);
  }

  /**
   * Runs `work` immediately, then re-schedules itself `delayMs` after each
   * run completes. Previously this waited a full `delayMs` before the very
   * first check — meaning a violation already present when monitoring
   * started (e.g. a phone already on the desk) could go undetected for up
   * to 5 seconds. Running the first check with no delay closes that gap.
   */
  private scheduleLoop(token: number, work: () => Promise<void>, delayMs: number): void {
    const tick = async () => {
      if (token !== this.sessionToken) return;
      await work();
      if (token !== this.sessionToken) return;
      setTimeout(tick, delayMs);
    };
    tick();
  }

  private async detectFace(token: number): Promise<void> {
    if (!this.video || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    try {
      // Cast to any[] explicitly: faceapi is typed `any`, and TS's generic
      // inference through withTimeout<T>()'s Promise<T> wrapper widens an
      // `any`-typed input to `unknown` rather than `any` — a known
      // TS quirk, not a real type-safety issue here.
      const detections = (await this.withTimeout(
        this.faceapi.detectAllFaces(this.video, this.faceMatcherOptions),
        5000,
        'detectFace'
      )) as any[];
      if (token !== this.sessionToken) return;

      if (detections.length === 0) {
        this.consecutiveNoFaceCount++;

        if (this.lastFaceState !== 'no_face_detected') {
          this.lastFaceState = 'no_face_detected';
          this.faceStatusSubject.next('no_face_detected');
        }

        if (this.consecutiveNoFaceCount === this.config.consecutiveMissesBeforeFlag) {
          this.faceFlaggedMissing = true;
          this.emitFlag('no_face_detected', 'medium', 'No face detected in the camera frame.');
          console.warn('No face detected for consecutive frames:', this.consecutiveNoFaceCount);
        }
      } else {
        const wasFlaggedMissing = this.faceFlaggedMissing;
        this.consecutiveNoFaceCount = 0;
        this.faceFlaggedMissing = false;

        if (this.lastFaceState !== 'face_detected') {
          this.lastFaceState = 'face_detected';
          this.faceStatusSubject.next('face_detected');
          if (wasFlaggedMissing) {
            this.emitFlag('face_restored', 'low', 'Face detected again.');
            console.log('Face restored after being flagged missing.');
          }
        }

        const facesMulti = detections.length > 1;
        if (facesMulti && !this.multiFaceActive) {
          this.multiFaceActive = true;
          if (!this.multiPersonObjActive) {
            this.emitFlag('additional_person_detected', 'high', 'Multiple faces detected in frame.');
            console.warn('Multiple faces detected:', detections.length);
          }
        } else if (!facesMulti && this.multiFaceActive) {
          this.multiFaceActive = false;
          if (!this.multiPersonObjActive) {
            this.emitFlag('person_left', 'low', 'Only one person visible now.');
          }
        }
      }
    } catch (error) {
      // Logged and swallowed (not re-thrown) so scheduleLoop's tick() still
      // schedules the NEXT iteration — one bad/slow frame shouldn't
      // permanently kill ongoing monitoring.
      console.error('Face detection error (loop continues):', error);
    }
  }

  private async detectObjects(token: number): Promise<void> {
    if (!this.video || !this.objectModel || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    try {
      const predictions = (await this.withTimeout(
        this.objectModel.detect(this.video, this.config.maxObjectBoxes, this.config.objectDetectionMinScore),
        5000,
        'detectObjects'
      )) as any[];
      if (token !== this.sessionToken) return;

      const suspicious = predictions.filter((pr: any) => this.config.watchedItems.includes(pr.class));
      if (suspicious.length > 0) {
        if (!this.objectActive) {
          this.objectActive = true;
          const items = Array.from(new Set(suspicious.map((pr: any) => pr.class))).join(', ');
          this.emitFlag('unauthorized_object', 'high', `Unauthorized item detected: ${items}.`);
          console.warn('Unauthorized items detected:', suspicious.map((pr: any) => pr.class));
        }
      } else if (this.objectActive) {
        this.objectActive = false;
        this.emitFlag('object_cleared', 'low', 'Restricted item no longer visible.');
        console.log('No unauthorized items detected in the current frame.');
      }

      const people = predictions.filter(
        (pr: any) => pr.class === 'person' && pr.score >= this.config.personCountMinScore
      );
      const peopleMulti = people.length > 1;
      if (peopleMulti && !this.multiPersonObjActive) {
        this.multiPersonObjActive = true;
        if (!this.multiFaceActive) {
          this.emitFlag('additional_person_detected', 'high', 'Multiple people detected in frame.');
        }
      } else if (!peopleMulti && this.multiPersonObjActive) {
        this.multiPersonObjActive = false;
        if (!this.multiFaceActive) {
          this.emitFlag('person_left', 'low', 'Only one person visible now.');
        }
      }
    } catch (error) {
      console.error('Object detection error (loop continues):', error);
    }
  }

  /**
   * Races a promise against a timeout so a stuck/hung inference call
   * (e.g. a lost WebGL context, or a tab backgrounded long enough for the
   * browser to throttle it) surfaces as a clear, catchable error instead
   * of leaving the caller (and the UI) waiting forever with no feedback.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms — likely a stuck WebGL/model call.`));
      }, ms);

      promise
        .then(value => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch(err => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Runs the FULL detection pipeline (detect → align → descriptor) rather
   * than calling computeFaceDescriptor() on a raw, un-detected image.
   * computeFaceDescriptor() alone assumes it's already been handed an
   * aligned face crop; calling it on a full photo (with background, body,
   * etc. still in frame) produces an inconsistent descriptor and is the
   * root cause of unreliable match/mismatch results.
   */
  private async getFaceDescriptor(
    element: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement
  ): Promise<Float32Array | null> {
    if (!this.faceapi) {
      console.error('[getFaceDescriptor] faceapi module not loaded yet — was initialize() awaited before this call?');
      return null;
    }
    if (!this.faceMatcherOptions) {
      console.error('[getFaceDescriptor] faceMatcherOptions not set yet — loadModels() may not have completed.');
      return null;
    }

    try {
      const detection = (await this.withTimeout(
        this.faceapi
          .detectSingleFace(element, this.faceMatcherOptions)
          .withFaceLandmarks()
          .withFaceDescriptor(),
        8000,
        'getFaceDescriptor'
      )) as any;

      return detection ? (detection.descriptor as Float32Array) : null;
    } catch (error) {
      console.error('[getFaceDescriptor] failed or timed out:', error);
      throw error;
    }
  }

  async setRegistrationPhoto(file: File): Promise<boolean> {
    if (!isPlatformBrowser(this.platformId) || !this.faceapi) return false;

    if (!this.registrationImgEl) {
      this.registrationImgEl = document.createElement('img');
    }

    try {
      await this.loadFileIntoImage(file, this.registrationImgEl);
      this.registrationDescriptor = await this.getFaceDescriptor(this.registrationImgEl);
      return this.registrationDescriptor !== null;
    } catch (error) {
      console.error('Failed to process registration photo:', error);
      return false;
    }
  }

  private loadFileIntoImage(file: File, imgEl: HTMLImageElement): Promise<void> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        imgEl.src = reader.result as string;
        try {
          await imgEl.decode();
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /**
   * Compares the live camera frame against the stored registration
   * descriptor. This is the SINGLE source of truth for identity
   * match/mismatch — both the initial "verify before starting the exam"
   * check and the periodic in-exam re-checks call this same method, and
   * both get their flags/logs from here. Nothing else should independently
   * log an identity result, to avoid duplicate log entries for one event.
   */
  async verifyLiveSnapshot(): Promise<FaceVerificationResult | null> {
    if (!this.video || !this.faceapi || !this.registrationDescriptor) {
      console.warn('[verifyLiveSnapshot] missing prerequisite:', {
        hasVideo: !!this.video,
        hasFaceapi: !!this.faceapi,
        hasRegistrationDescriptor: !!this.registrationDescriptor
      });
      return null;
    }
    if (this.video.videoWidth === 0 || this.video.videoHeight === 0) {
      console.warn('[verifyLiveSnapshot] video has no dimensions yet — camera not ready.');
      return null;
    }

    const snapshot = this.captureSnapshot();
    if (!snapshot) {
      console.warn('[verifyLiveSnapshot] captureSnapshot() returned null.');
      return null;
    }

    try {
      const liveDescriptor = await this.getFaceDescriptor(this.snapshotCanvas!);
      if (!liveDescriptor) {
        console.warn('[verifyLiveSnapshot] no face found in the live snapshot.');
        return null;
      }

      const distance = this.faceapi.euclideanDistance(this.registrationDescriptor, liveDescriptor);
      const isMatch = distance < this.config.faceMatchDistanceThreshold;

      if (!isMatch) {
        this.identityMismatchActive = true;
        this.emitFlag('identity_mismatch', 'high', `Live face does not match registration photo (distance ${distance.toFixed(2)}).`);
      } else if (this.identityMismatchActive) {
        this.identityMismatchActive = false;
        this.emitFlag('identity_restored', 'low', `Identity re-verified (distance ${distance.toFixed(2)}).`);
      }

      return { isMatch, distance, snapshot };
    } catch (error) {
      // getFaceDescriptor() throws (rather than hanging) on a timeout or a
      // genuine face-api error — re-thrown here so the caller (e.g.
      // verifyAndStartExam) can surface it to the UI instead of the
      // promise staying pending forever.
      console.error('Live identity verification error:', error);
      throw error;
    }
  }

  async verifyIdentity(
    registrationPhotoImg: HTMLImageElement,
    loginPhotoImg: HTMLImageElement,
    governmentIdImg?: HTMLImageElement
  ): Promise<IdentityVerificationResult> {
    if (!this.faceapi) throw new Error('Face API not loaded');

    const [desc1, desc2] = await Promise.all([
      this.getFaceDescriptor(registrationPhotoImg),
      this.getFaceDescriptor(loginPhotoImg)
    ]);

    if (!desc1 || !desc2) {
      return { isMatch: false, distance: 1.0, snapshot: null, governmentIdSnapshot: null };
    }

    const distance = this.faceapi.euclideanDistance(desc1, desc2);
    const isMatch = distance < this.config.faceMatchDistanceThreshold;

    let governmentIdSnapshot: string | null = null;
    if (governmentIdImg && isPlatformBrowser(this.platformId)) {
      governmentIdSnapshot = this.encodeImageElement(governmentIdImg);
    }

    return { isMatch, distance, snapshot: null, governmentIdSnapshot };
  }

  private encodeImageElement(img: HTMLImageElement): string | null {
    if (!this.snapshotCanvas || !this.snapshotCtx) return null;
    this.snapshotCanvas.width = img.naturalWidth || 640;
    this.snapshotCanvas.height = img.naturalHeight || 480;
    this.snapshotCtx.drawImage(img, 0, 0, this.snapshotCanvas.width, this.snapshotCanvas.height);
    return this.snapshotCanvas.toDataURL('image/jpeg', 0.8);
  }

  startPeriodicIdentityCheck(
    intervalMs: number = this.config.defaultIdentityCheckIntervalMs,
    onResult?: (result: FaceVerificationResult | null) => void
  ): void {
    if (this.identityCheckIntervalId) return;
    this.identityCheckIntervalId = setInterval(async () => {
      const result = await this.verifyLiveSnapshot();
      onResult?.(result);
    }, intervalMs);
  }

  stopPeriodicIdentityCheck(): void {
    if (this.identityCheckIntervalId) {
      clearInterval(this.identityCheckIntervalId);
      this.identityCheckIntervalId = null;
    }
  }

  public captureSnapshot(): string | null {
    if (!this.video || !this.snapshotCanvas || !this.snapshotCtx) return null;
    if (this.video.videoWidth === 0 || this.video.videoHeight === 0) return null;

    this.snapshotCanvas.width = this.video.videoWidth;
    this.snapshotCanvas.height = this.video.videoHeight;
    this.snapshotCtx.drawImage(this.video, 0, 0);
    return this.snapshotCanvas.toDataURL('image/jpeg', this.config.snapshotQuality);
  }

  /**
   * The single place that produces both a structured ProctoringFlag (for
   * consumers that want to react to specific flag types, e.g. updating a
   * status dot) and a DetectionLogEntry (for consumers that just want a
   * chronological, human-readable console/activity feed). Every call site
   * above is edge-triggered — called once when a condition starts and once
   * when it clears — so this never gets invoked on a fixed timer.
   */
  private emitFlag(flagType: ProctoringFlagType, severity: ProctoringSeverity, message: string): void {
    const timestamp = new Date().toISOString();

    const flag: ProctoringFlag = {
      candidateId: this.candidateId,
      examId: this.examId,
      flagType,
      severity,
      timestamp,
      snapshot: this.captureSnapshot()
    };

    console.warn(`[PROCTOR] ${flagType} (${severity}): ${message}`);
    this.flagsSubject.next(flag);
    this.logsSubject.next({ message, severity, timestamp });
  }

  private setupBrowserListeners(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('blur', this.blurHandler);
    window.addEventListener('focus', this.focusHandler);
  }

  private teardownBrowserListeners(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    window.removeEventListener('blur', this.blurHandler);
    window.removeEventListener('focus', this.focusHandler);
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  get running(): boolean {
    return this.isRunning;
  }

  stopDetection(): void {
    this.sessionToken++;
    this.isRunning = false;
    this.consecutiveNoFaceCount = 0;
    this.faceFlaggedMissing = false;
    this.lastFaceState = null;
    this.multiFaceActive = false;
    this.multiPersonObjActive = false;
    this.objectActive = false;
  }

  stopCamera(): void {
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;

    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
  }

  stopProctoring(): void {
    this.stopDetection();
    this.stopCamera();
    this.stopPeriodicIdentityCheck();
    this.teardownBrowserListeners();
  }

  ngOnDestroy(): void {
    this.stopProctoring();
    this.flagsSubject.complete();
    this.faceStatusSubject.complete();
    this.logsSubject.complete();
  }
}