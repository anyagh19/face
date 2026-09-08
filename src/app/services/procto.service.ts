import { Injectable, Inject, InjectionToken, PLATFORM_ID, OnDestroy } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Observable, Subject } from 'rxjs';

// =============================================================================
// Types
// =============================================================================

export type ProctoringFlagType =
  | 'no_face_detected'
  | 'additional_person_detected'
  | 'unauthorized_object'
  | 'tab_switched'
  | 'window_lost_focus'
  | 'identity_mismatch'
  | 'camera_error';

export type ProctoringSeverity = 'low' | 'medium' | 'high';

export interface ProctoringFlag {
  candidateId: string;
  examId: string;
  flagType: ProctoringFlagType;
  severity: ProctoringSeverity;
  timestamp: string;
  snapshot: string | null;
}

export interface FaceVerificationResult {
  isMatch: boolean;
  distance: number;
  snapshot: string | null;
}

export interface IdentityVerificationResult extends FaceVerificationResult {
  governmentIdSnapshot: string | null;
}

// =============================================================================
// Config
// =============================================================================

export interface ProctoringConfig {
  modelUrl: string;
  watchedItems: string[];
  objectDetectionMinScore: number;
  personCountMinScore: number;
  faceCheckIntervalMs: number;
  objectCheckIntervalMs: number;
  consecutiveMissesBeforeFlag: number;
  faceMatchDistanceThreshold: number;
  defaultIdentityCheckIntervalMs: number;
  snapshotQuality: number;
}

export const DEFAULT_PROCTORING_CONFIG: ProctoringConfig = {
  modelUrl: '/models/face-api',
  watchedItems: ['cell phone', 'book', 'laptop', 'tvmonitor'],
  objectDetectionMinScore: 0.3,
  personCountMinScore: 0.6,
  faceCheckIntervalMs: 1000,
  objectCheckIntervalMs: 5000,
  consecutiveMissesBeforeFlag: 3,
  faceMatchDistanceThreshold: 0.6,
  defaultIdentityCheckIntervalMs: 5 * 60 * 1000,
  snapshotQuality: 0.6
};

export const PROCTORING_CONFIG = new InjectionToken<ProctoringConfig>('PROCTORING_CONFIG', {
  providedIn: 'root',
  factory: () => DEFAULT_PROCTORING_CONFIG
});

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

  private readonly flagsSubject = new Subject<ProctoringFlag>();
  readonly flags$: Observable<ProctoringFlag> = this.flagsSubject.asObservable();

  private readonly faceStatusSubject = new Subject<'face_detected' | 'no_face_detected'>();
  readonly faceStatus$ = this.faceStatusSubject.asObservable();

  private readonly visibilityHandler = () => {
    if (document.hidden) {
      this.emitFlag('tab_switched', 'medium');
    }
  };
  private readonly blurHandler = () => {
    this.emitFlag('window_lost_focus', 'medium');
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

  private async withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
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
      this.emitFlag('camera_error', 'high');
      return false;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      console.error(
        'navigator.mediaDevices.getUserMedia is not available in this browser/context. ' +
        'This usually means: (a) an insecure context (see above), (b) a very old browser, ' +
        'or (c) the page is embedded in an iframe whose "allow" attribute does not include ' +
        '"camera", or whose parent site sends a Permissions-Policy header blocking camera access.'
      );
      this.emitFlag('camera_error', 'high');
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
      console.error(
        `Unable to access camera [${name ?? 'UnknownError'}]: ${reasons[name ?? ''] ?? 'Unrecognized error.'}`,
        error
      );
      this.emitFlag('camera_error', 'high');
      return false;
    }
  }

  startDetection(): void {
    if (!isPlatformBrowser(this.platformId) || !this.faceapi || !this.video || this.isRunning) {
      return;
    }

    this.isRunning = true;
    const token = this.sessionToken;

    this.scheduleLoop(token, () => this.detectFace(token), this.config.faceCheckIntervalMs);
    this.scheduleLoop(token, () => this.detectObjects(token), this.config.objectCheckIntervalMs);
  }

  private scheduleLoop(token: number, work: () => Promise<void>, delayMs: number): void {
    const tick = async () => {
      if (token !== this.sessionToken) return;
      await work();
      if (token !== this.sessionToken) return;
      setTimeout(tick, delayMs);
    };
    setTimeout(tick, delayMs);
  }

  private async detectFace(token: number): Promise<void> {
    if (!this.video || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    try {
      const detections = await this.faceapi.detectAllFaces(this.video, this.faceMatcherOptions);
      if (token !== this.sessionToken) return;

      if (detections.length === 0) {
        this.consecutiveNoFaceCount++;
        this.faceStatusSubject.next('no_face_detected');

        if (this.consecutiveNoFaceCount >= this.config.consecutiveMissesBeforeFlag) {
          this.emitFlag('no_face_detected', 'medium');
        }
      } else {
        this.consecutiveNoFaceCount = 0;
        this.faceStatusSubject.next('face_detected');

        if (detections.length > 1) {
          this.emitFlag('additional_person_detected', 'high');
        }
      }
    } catch (error) {
      console.error('Face detection error:', error);
    }
  }

  private async detectObjects(token: number): Promise<void> {
    if (!this.video || !this.objectModel || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    try {
      const predictions = await this.objectModel.detect(
        this.video,
        20,
        this.config.objectDetectionMinScore
      );
      if (token !== this.sessionToken) return;

      const suspicious = predictions.filter((pr: any) => this.config.watchedItems.includes(pr.class));
      if (suspicious.length > 0) {
        this.emitFlag('unauthorized_object', 'high');
      }

      const people = predictions.filter(
        (pr: any) => pr.class === 'person' && pr.score >= this.config.personCountMinScore
      );
      if (people.length > 1) {
        this.emitFlag('additional_person_detected', 'high');
      }
    } catch (error) {
      console.error('Object detection error:', error);
    }
  }

  async setRegistrationPhoto(file: File): Promise<boolean> {
    if (!isPlatformBrowser(this.platformId) || !this.faceapi) return false;

    if (!this.registrationImgEl) {
      this.registrationImgEl = document.createElement('img');
    }

    try {
      await this.loadFileIntoImage(file, this.registrationImgEl);
      const descriptor = await this.faceapi.computeFaceDescriptor(this.registrationImgEl);
      this.registrationDescriptor = descriptor ?? null;
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

  async verifyLiveSnapshot(): Promise<FaceVerificationResult | null> {
    if (!this.video || !this.faceapi || !this.registrationDescriptor) return null;
    if (this.video.videoWidth === 0 || this.video.videoHeight === 0) return null;

    const snapshot = this.captureSnapshot();
    if (!snapshot) return null;

    try {
      const liveDescriptor = await this.faceapi.computeFaceDescriptor(this.snapshotCanvas);
      if (!liveDescriptor) return null;

      const distance = this.faceapi.euclideanDistance(this.registrationDescriptor, liveDescriptor);
      const isMatch = distance < this.config.faceMatchDistanceThreshold;

      if (!isMatch) {
        this.emitFlag('identity_mismatch', 'high');
      }

      return { isMatch, distance, snapshot };
    } catch (error) {
      console.error('Live identity verification error:', error);
      return null;
    }
  }

  async verifyIdentity(
    registrationPhotoImg: HTMLImageElement,
    loginPhotoImg: HTMLImageElement,
    governmentIdImg?: HTMLImageElement
  ): Promise<IdentityVerificationResult> {
    if (!this.faceapi) throw new Error('Face API not loaded');

    const [desc1, desc2] = await Promise.all([
      this.faceapi.computeFaceDescriptor(registrationPhotoImg),
      this.faceapi.computeFaceDescriptor(loginPhotoImg)
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

  private emitFlag(flagType: ProctoringFlagType, severity: ProctoringSeverity): void {
    const flag: ProctoringFlag = {
      candidateId: this.candidateId,
      examId: this.examId,
      flagType,
      severity,
      timestamp: new Date().toISOString(),
      snapshot: this.captureSnapshot()
    };

    console.warn(`🚨 [PROCTOR FLAG] ${flagType} (${severity})`);
    this.flagsSubject.next(flag);
  }

  private setupBrowserListeners(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('blur', this.blurHandler);
  }

  private teardownBrowserListeners(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    window.removeEventListener('blur', this.blurHandler);
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
  }
}