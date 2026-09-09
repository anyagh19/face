import {
  Injectable,
  Inject,
  PLATFORM_ID,
  OnDestroy
} from '@angular/core';

import { isPlatformBrowser } from '@angular/common';

import {
  Observable,
  Subject
} from 'rxjs';

import type {
  ProctoringFlag,
  ProctoringFlagType,
  ProctoringSeverity,
  FaceVerificationResult,
  IdentityVerificationResult,
  DetectionLogEntry
} from './procto.types';

import {
  ProctoringConfig,
  PROCTORING_CONFIG
} from './procto.config';

export type { ProctoringConfig } from './procto.config';

export {
  PROCTORING_CONFIG,
  DEFAULT_PROCTORING_CONFIG
} from './procto.config';

export * from './procto.types';

// =============================================================================
// NEW: Pre-exam room-check result type.
//
// Deliberately separate from ProctoringFlag: room-check findings are shown
// to the candidate/proctor as a distinct "pre-exam room check" outcome,
// not as exam-time violations, so they get their own lightweight shape
// instead of reusing ProctoringFlag (which carries candidateId/examId/
// flagType fields meant for the exam-time violation stream).
// =============================================================================
export interface RoomCheckResult {
  message: string;
  severity: ProctoringSeverity;
  kind: 'unauthorized_object' | 'multiple_people' | 'ok';
  timestamp: string;
}

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

  // =========================================================================
  // NEW:
  // Separate, more permissive/higher-resolution detector options used ONLY
  // for identity verification (landmarks + descriptor extraction).
  //
  // `faceMatcherOptions` (inputSize 416, scoreThreshold 0.3) is tuned for the
  // cheap, continuous "is a face in frame at all" check (`detectAllFaces`,
  // used by detectFace()/faceStatus$). That check is intentionally lenient.
  //
  // But `detectSingleFace(...).withFaceLandmarks().withFaceDescriptor()`
  // needs a clearer, larger face to reliably extract 68 landmarks and a
  // 128-d descriptor. Reusing the lenient options for this stricter job
  // meant "Face detected" could show green in the UI while descriptor
  // extraction silently returned null underneath — which is why identity
  // verification was failing every time even with a face clearly in frame.
  // =========================================================================
  private identityDetectorOptions: any = null;

  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;

  private readonly snapshotCanvas: HTMLCanvasElement | null;
  private readonly snapshotCtx: CanvasRenderingContext2D | null;

  private isRunning = false;
  private sessionToken = 0;

  private consecutiveNoFaceCount = 0;

  private registrationDescriptor: Float32Array | null = null;
  private registrationImgEl: HTMLImageElement | null = null;

  private identityCheckIntervalId:
    ReturnType<typeof setInterval> | null = null;

  public candidateId = 'unknown-candidate';
  public examId = 'unknown-exam';

  // ---------------------------------------------------------------------
  // Edge-tracking state.
  // ---------------------------------------------------------------------

  private lastFaceState:
    'face_detected' | 'no_face_detected' | null = null;

  private faceFlaggedMissing = false;

  private multiFaceActive = false;
  private multiPersonObjActive = false;

  private objectActive = false;

  private identityMismatchActive = false;

  private tabHidden = false;
  private windowBlurred = false;

  private get personActive(): boolean {
    return (
      this.multiFaceActive ||
      this.multiPersonObjActive
    );
  }

  private readonly flagsSubject =
    new Subject<ProctoringFlag>();

  readonly flags$:
    Observable<ProctoringFlag> =
    this.flagsSubject.asObservable();

  /**
   * Unified, human-readable, console-style event stream.
   */
  private readonly logsSubject =
    new Subject<DetectionLogEntry>();

  readonly logs$:
    Observable<DetectionLogEntry> =
    this.logsSubject.asObservable();

  private readonly faceStatusSubject =
    new Subject<
      'face_detected' | 'no_face_detected'
    >();

  readonly faceStatus$ =
    this.faceStatusSubject.asObservable();

  private readonly visibilityHandler = () => {

    if (document.hidden) {

      this.tabHidden = true;

      this.emitFlag(
        'tab_switched',
        'medium',
        'Exam tab was switched or minimized.'
      );

    } else if (this.tabHidden) {

      this.tabHidden = false;

      this.emitFlag(
        'tab_restored',
        'low',
        'Returned to the exam tab.'
      );
    }
  };

  private readonly blurHandler = () => {

    if (!this.windowBlurred) {

      this.windowBlurred = true;

      this.emitFlag(
        'window_lost_focus',
        'medium',
        'Exam window lost focus.'
      );
    }
  };

  private readonly focusHandler = () => {

    if (this.windowBlurred) {

      this.windowBlurred = false;

      this.emitFlag(
        'window_focus_restored',
        'low',
        'Exam window regained focus.'
      );
    }
  };

  constructor(
    @Inject(PLATFORM_ID)
    private readonly platformId: Object,

    @Inject(PROCTORING_CONFIG)
    private readonly config: ProctoringConfig
  ) {

    if (isPlatformBrowser(this.platformId)) {

      this.snapshotCanvas =
        document.createElement('canvas');

      this.snapshotCtx =
        this.snapshotCanvas.getContext('2d');

    } else {

      this.snapshotCanvas = null;
      this.snapshotCtx = null;
    }
  }

  async initialize(): Promise<boolean> {

    if (!isPlatformBrowser(this.platformId)) {

      console.log(
        'Proctoring skipped during SSR'
      );

      return false;
    }

    if (
      this.faceapi &&
      this.cocoSsd &&
      this.objectModel
    ) {

      return true;
    }

    try {

      const [
        faceApiModule,
        cocoSsdModule
      ] = await Promise.all([

        import('@vladmandic/face-api'),

        import('@tensorflow-models/coco-ssd')

      ]);

      this.faceapi = faceApiModule;
      this.cocoSsd = cocoSsdModule;

      await this.loadModels();

      // Warm-up
      await this.warmUpModels();

      this.setupBrowserListeners();

      return true;

    } catch (error) {

      console.error(
        'Failed to initialize AI modules:',
        error
      );

      return false;
    }
  }

  private async loadModels(): Promise<void> {

    if (
      !this.faceapi ||
      !this.cocoSsd
    ) {

      throw new Error(
        'AI modules not initialized.'
      );
    }

    await this.withRetry(() =>
      Promise.all([

        this.faceapi.nets.tinyFaceDetector
          .loadFromUri(
            this.config.modelUrl
          ),

        this.faceapi.nets.faceLandmark68Net
          .loadFromUri(
            this.config.modelUrl
          ),

        this.faceapi.nets.faceRecognitionNet
          .loadFromUri(
            this.config.modelUrl
          )

      ])
    );

    // CHANGED:
    // Better live-camera detection. inputSize raised 416 -> 512 and
    // scoreThreshold lowered 0.3 -> 0.25 so a face at normal sitting
    // distance (not leaned in close) is still confidently detected —
    // previously only a face filling most of the frame scored high
    // enough to register as "present".
    this.faceMatcherOptions =
      new this.faceapi.TinyFaceDetectorOptions({

        inputSize: 512,

        scoreThreshold: 0.25

      });

    // =========================================================================
    // NEW:
    // Dedicated options for identity verification (landmarks + descriptor).
    // Larger inputSize improves landmark/descriptor accuracy, and a lower
    // scoreThreshold avoids rejecting a face that the presence-check would
    // still happily call "detected".
    // =========================================================================
    // CHANGED: inputSize raised 512 -> 608 (the maximum TinyFaceDetector
    // supports) and scoreThreshold lowered 0.2 -> 0.15, for the same
    // reason as faceMatcherOptions above — a normal-distance face needs
    // more resolution and a lower confidence bar to reliably yield
    // landmarks + a descriptor, not just a bounding box.
    this.identityDetectorOptions =
      new this.faceapi.TinyFaceDetectorOptions({

        inputSize: 608,

        scoreThreshold: 0.15

      });

    this.objectModel =
      await this.withRetry(() =>
        this.cocoSsd.load()
      );
  }

  /**
   * Runs one throwaway detection pass on a blank canvas.
   */
  private async warmUpModels(): Promise<void> {

    if (
      !this.faceapi ||
      !this.identityDetectorOptions
    ) {
      return;
    }

    try {

      const warmupCanvas =
        document.createElement('canvas');

      warmupCanvas.width = 320;
      warmupCanvas.height = 320;

      const ctx =
        warmupCanvas.getContext('2d');

      if (ctx) {

        ctx.fillStyle = '#808080';

        ctx.fillRect(
          0,
          0,
          warmupCanvas.width,
          warmupCanvas.height
        );
      }

      await this.withTimeout(

        this.faceapi
          .detectSingleFace(
            warmupCanvas,
            this.identityDetectorOptions
          )
          .withFaceLandmarks()
          .withFaceDescriptor(),

        15000,

        'warmUpModels'
      );

    } catch {
      // Warm-up failure is ignored.
    }
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    retries = 2
  ): Promise<T> {

    try {

      return await fn();

    } catch (err) {

      if (retries <= 0) {
        throw err;
      }

      await new Promise(
        resolve => setTimeout(resolve, 500)
      );

      return this.withRetry(
        fn,
        retries - 1
      );
    }
  }

  async startCamera(
    videoElement: HTMLVideoElement
  ): Promise<boolean> {

    if (
      !isPlatformBrowser(this.platformId)
    ) {
      return false;
    }

    if (!window.isSecureContext) {

      console.error(
        'Camera access requires a secure context (HTTPS, or http://localhost). ' +
        `Current origin: ${window.location.origin}. getUserMedia is unavailable on plain ` +
        'HTTP for any host other than localhost/127.0.0.1 — this is a browser-enforced ' +
        'restriction, not something fixable in code.'
      );

      this.emitFlag(
        'camera_error',
        'high',
        'Camera unavailable: page is not on a secure origin.'
      );

      return false;
    }

    if (
      !navigator.mediaDevices?.getUserMedia
    ) {

      console.error(
        'navigator.mediaDevices.getUserMedia is not available in this browser/context. ' +
        'This usually means: (a) an insecure context (see above), (b) a very old browser, ' +
        'or (c) the page is embedded in an iframe whose "allow" attribute does not include ' +
        '"camera", or whose parent site sends a Permissions-Policy header blocking camera access.'
      );

      this.emitFlag(
        'camera_error',
        'high',
        'Camera API not available in this browser/context.'
      );

      return false;
    }

    try {

      this.video = videoElement;

      this.stream =
        await navigator.mediaDevices.getUserMedia({

          video: {
            // CHANGED: raised from 640x480. A face at normal sitting
            // distance was only a small cluster of pixels in a 640x480
            // frame, which is why the detector needed you to lean in
            // close ("make your eyes big") to find enough detail to
            // work with. 1280x720 gives it much more to work with at
            // a normal distance.
            width: {
              ideal: 1280
            },

            height: {
              ideal: 720
            },

            facingMode: 'user'
          },

          audio: false

        });

      this.video.srcObject =
        this.stream;

      await this.video.play();

      return true;

    } catch (error) {

      const name =
        (error as DOMException)?.name;

      const reasons: Record<string, string> = {

        NotAllowedError:
          'Permission was denied (by the user, or by a previous block that needs to be reset in browser site settings).',

        NotFoundError:
          'No camera device was found on this machine.',

        NotReadableError:
          'The camera is already in use by another application or browser tab.',

        OverconstrainedError:
          'No camera satisfies the requested constraints (resolution/facingMode).',

        SecurityError:
          'Blocked by a security policy (insecure context or Permissions-Policy).',

        AbortError:
          'Camera access was aborted, possibly due to a hardware or OS-level issue.'
      };

      const reason =
        reasons[name ?? '']
        ?? 'Unrecognized error.';

      console.error(
        `Unable to access camera [${name ?? 'UnknownError'}]: ${reason}`,
        error
      );

      this.emitFlag(
        'camera_error',
        'high',
        `Camera access failed: ${reason}`
      );

      return false;
    }
  }

  startDetection(): void {

    if (
      !isPlatformBrowser(this.platformId) ||
      !this.faceapi ||
      !this.video ||
      this.isRunning
    ) {
      return;
    }

    this.isRunning = true;

    const token =
      this.sessionToken;

    this.logsSubject.next({

      message:
        'Live monitoring started.',

      severity:
        'low',

      timestamp:
        new Date().toISOString()

    });

    this.scheduleLoop(
      token,
      () => this.detectFace(token),
      this.config.faceCheckIntervalMs
    );

    this.scheduleLoop(
      token,
      () => this.detectObjects(token),
      this.config.objectCheckIntervalMs
    );
  }

  private scheduleLoop(
    token: number,
    work: () => Promise<void>,
    delayMs: number
  ): void {

    const tick = async () => {

      if (
        token !== this.sessionToken
      ) {
        return;
      }

      await work();

      if (
        token !== this.sessionToken
      ) {
        return;
      }

      setTimeout(
        tick,
        delayMs
      );
    };

    tick();
  }

  private async detectFace(
    token: number
  ): Promise<void> {

    if (
      !this.video ||
      this.video.readyState <
        HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return;
    }

    try {

      const detections =
        (await this.withTimeout(

          this.faceapi.detectAllFaces(
            this.video,
            this.faceMatcherOptions
          ),

          5000,

          'detectFace'

        )) as any[];

      if (
        token !== this.sessionToken
      ) {
        return;
      }

      if (
        detections.length === 0
      ) {

        this.consecutiveNoFaceCount++;

        if (
          this.lastFaceState !==
          'no_face_detected'
        ) {

          this.lastFaceState =
            'no_face_detected';

          this.faceStatusSubject.next(
            'no_face_detected'
          );
        }

        if (
          this.consecutiveNoFaceCount ===
          this.config.consecutiveMissesBeforeFlag
        ) {

          this.faceFlaggedMissing =
            true;

          this.emitFlag(
            'no_face_detected',
            'medium',
            'No face detected in the camera frame.'
          );

          console.warn(
            'No face detected for consecutive frames:',
            this.consecutiveNoFaceCount
          );
        }

      } else {

        const wasFlaggedMissing =
          this.faceFlaggedMissing;

        this.consecutiveNoFaceCount =
          0;

        this.faceFlaggedMissing =
          false;

        if (
          this.lastFaceState !==
          'face_detected'
        ) {

          this.lastFaceState =
            'face_detected';

          this.faceStatusSubject.next(
            'face_detected'
          );

          if (wasFlaggedMissing) {

            this.emitFlag(
              'face_restored',
              'low',
              'Face detected again.'
            );

            console.log(
              'Face restored after being flagged missing.'
            );
          }
        }

        const facesMulti =
          detections.length > 1;

        if (
          facesMulti &&
          !this.multiFaceActive
        ) {

          this.multiFaceActive =
            true;

          if (
            !this.multiPersonObjActive
          ) {

            this.emitFlag(
              'additional_person_detected',
              'high',
              'Multiple faces detected in frame.'
            );

            console.warn(
              'Multiple faces detected:',
              detections.length
            );
          }

        } else if (
          !facesMulti &&
          this.multiFaceActive
        ) {

          this.multiFaceActive =
            false;

          if (
            !this.multiPersonObjActive
          ) {

            this.emitFlag(
              'person_left',
              'low',
              'Only one person visible now.'
            );
          }
        }
      }

    } catch (error) {

      console.error(
        'Face detection error (loop continues):',
        error
      );
    }
  }

  private async detectObjects(
    token: number
  ): Promise<void> {

    if (
      !this.video ||
      !this.objectModel ||
      this.video.readyState <
        HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return;
    }

    try {

      const predictions =
        (await this.withTimeout(

          this.objectModel.detect(
            this.video,
            this.config.maxObjectBoxes,
            this.config.objectDetectionMinScore
          ),

          5000,

          'detectObjects'

        )) as any[];

      if (
        token !== this.sessionToken
      ) {
        return;
      }

      const suspicious =
        predictions.filter(
          (pr: any) =>
            this.config.watchedItems.includes(
              pr.class
            )
        );

      if (
        suspicious.length > 0
      ) {

        if (!this.objectActive) {

          this.objectActive = true;

          const items =
            Array.from(
              new Set(
                suspicious.map(
                  (pr: any) => pr.class
                )
              )
            ).join(', ');

          this.emitFlag(
            'unauthorized_object',
            'high',
            `Unauthorized item detected: ${items}.`
          );

          console.warn(
            'Unauthorized items detected:',
            suspicious.map(
              (pr: any) => pr.class
            )
          );
        }

      } else if (
        this.objectActive
      ) {

        this.objectActive = false;

        this.emitFlag(
          'object_cleared',
          'low',
          'Restricted item no longer visible.'
        );

        console.log(
          'No unauthorized items detected in the current frame.'
        );
      }

      const people =
        predictions.filter(

          (pr: any) =>
            pr.class === 'person' &&
            pr.score >=
              this.config.personCountMinScore

        );

      const peopleMulti =
        people.length > 1;

      if (
        peopleMulti &&
        !this.multiPersonObjActive
      ) {

        this.multiPersonObjActive =
          true;

        if (
          !this.multiFaceActive
        ) {

          this.emitFlag(
            'additional_person_detected',
            'high',
            'Multiple people detected in frame.'
          );
        }

      } else if (
        !peopleMulti &&
        this.multiPersonObjActive
      ) {

        this.multiPersonObjActive =
          false;

        if (
          !this.multiFaceActive
        ) {

          this.emitFlag(
            'person_left',
            'low',
            'Only one person visible now.'
          );
        }
      }

    } catch (error) {

      console.error(
        'Object detection error (loop continues):',
        error
      );
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string
  ): Promise<T> {

    return new Promise<T>(
      (resolve, reject) => {

        const timer =
          setTimeout(() => {

            reject(
              new Error(
                `${label} timed out after ${ms}ms — likely a stuck WebGL/model call.`
              )
            );

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
      }
    );
  }

  private async getFaceDescriptor(
    element:
      | HTMLImageElement
      | HTMLCanvasElement
      | HTMLVideoElement
  ): Promise<Float32Array | null> {

    if (!this.faceapi) {

      console.error(
        '[getFaceDescriptor] faceapi module not loaded yet — was initialize() awaited before this call?'
      );

      return null;
    }

    // CHANGED:
    // Use the dedicated identity detector options (higher inputSize, lower
    // scoreThreshold) instead of the lenient presence-check options, since
    // landmark + descriptor extraction needs a clearer detection than a
    // simple "is there a face" check does.
    if (!this.identityDetectorOptions) {

      console.error(
        '[getFaceDescriptor] identityDetectorOptions not set yet — loadModels() may not have completed.'
      );

      return null;
    }

    try {

      const detection =
        (await this.withTimeout(

          this.faceapi
            .detectSingleFace(
              element,
              this.identityDetectorOptions
            )
            .withFaceLandmarks()
            .withFaceDescriptor(),

          8000,

          'getFaceDescriptor'

        )) as any;

      return detection
        ? (
            detection.descriptor
            
          )
        : null;

    } catch (error) {

      console.error(
        '[getFaceDescriptor] failed or timed out:',
        error
      );

      throw error;
    }
  }

  async setRegistrationPhoto(
    file: File
  ): Promise<boolean> {

    if (
      !isPlatformBrowser(this.platformId) ||
      !this.faceapi
    ) {
      return false;
    }

    if (!this.registrationImgEl) {

      this.registrationImgEl =
        document.createElement('img');
    }

    try {

      this.logsSubject.next({

        message:
          'Decoding registration photo...',

        severity:
          'low',

        timestamp:
          new Date().toISOString()

      });

      await this.loadFileIntoImage(
        file,
        this.registrationImgEl
      );

      this.logsSubject.next({

        message:
          'Detecting face in registration photo...',

        severity:
          'low',

        timestamp:
          new Date().toISOString()

      });

      const detectionInput =
        this.prepareImageForDetection(
          this.registrationImgEl
        );

      this.registrationDescriptor =
        await this.getFaceDescriptor(
          detectionInput
        );

      return (
        this.registrationDescriptor !==
        null
      );

    } catch (error) {

      console.error(
        'Failed to process registration photo:',
        error
      );

      this.logsSubject.next({

        message:
          'Registration photo processing failed or timed out.',

        severity:
          'high',

        timestamp:
          new Date().toISOString()

      });

      return false;
    }
  }

  private loadFileIntoImage(
    file: File,
    imgEl: HTMLImageElement
  ): Promise<void> {

    return new Promise(
      (resolve, reject) => {

        const timer =
          setTimeout(() => {

            reject(
              new Error(
                'loadFileIntoImage timed out after 8000ms — image failed to decode.'
              )
            );

          }, 8000);

        const reader =
          new FileReader();

        reader.onload = async () => {

          imgEl.src =
            reader.result as string;

          try {

            await imgEl.decode();

            clearTimeout(timer);

            resolve();

          } catch (err) {

            clearTimeout(timer);

            reject(err);
          }
        };

        reader.onerror = () => {

          clearTimeout(timer);

          reject(reader.error);
        };

        reader.readAsDataURL(file);
      }
    );
  }

  private prepareImageForDetection(
    source: HTMLImageElement,

    // CHANGED: 800 -> 1280. This was capping resolution below the new
    // 1280x720 camera capture size, throwing away exactly the extra
    // detail the higher inputSize settings above are meant to use.
    maxDim: number = 1280
  ): HTMLCanvasElement {

    const width =
      source.naturalWidth ||
      source.width;

    const height =
      source.naturalHeight ||
      source.height;

    const scale =
      Math.min(
        1,
        maxDim /
          Math.max(
            width,
            height
          )
      );

    const targetWidth =
      Math.max(
        1,
        Math.round(
          width * scale
        )
      );

    const targetHeight =
      Math.max(
        1,
        Math.round(
          height * scale
        )
      );

    const canvas =
      document.createElement(
        'canvas'
      );

    canvas.width =
      targetWidth;

    canvas.height =
      targetHeight;

    const ctx =
      canvas.getContext('2d');

    if (ctx) {

      ctx.drawImage(
        source,
        0,
        0,
        targetWidth,
        targetHeight
      );
    }

    return canvas;
  }

  // ===========================================================================
  // NEW:
  // Resize live camera snapshot before sending it to TinyFaceDetector.
  // This makes the live verification path consistent with the registration
  // photo path.
  // ===========================================================================

  private prepareCanvasForDetection(
    source: HTMLCanvasElement,

    // CHANGED: 800 -> 1280, matching the new 1280x720 camera capture
    // size — see prepareImageForDetection above for why.
    maxDim: number = 1280
  ): HTMLCanvasElement {

    const width =
      source.width;

    const height =
      source.height;

    const scale =
      Math.min(
        1,
        maxDim /
          Math.max(
            width,
            height
          )
      );

    const targetWidth =
      Math.max(
        1,
        Math.round(
          width * scale
        )
      );

    const targetHeight =
      Math.max(
        1,
        Math.round(
          height * scale
        )
      );

    const canvas =
      document.createElement(
        'canvas'
      );

    canvas.width =
      targetWidth;

    canvas.height =
      targetHeight;

    const ctx =
      canvas.getContext('2d');

    if (ctx) {

      ctx.drawImage(
        source,
        0,
        0,
        targetWidth,
        targetHeight
      );
    }

    return canvas;
  }

  async verifyLiveSnapshot():
    Promise<
      FaceVerificationResult | null
    > {

    if (
      !this.video ||
      !this.faceapi ||
      !this.registrationDescriptor
    ) {

      console.warn(
        '[verifyLiveSnapshot] missing prerequisite:',
        {
          hasVideo:
            !!this.video,

          hasFaceapi:
            !!this.faceapi,

          hasRegistrationDescriptor:
            !!this.registrationDescriptor
        }
      );

      return null;
    }

    if (
      this.video.videoWidth === 0 ||
      this.video.videoHeight === 0
    ) {

      console.warn(
        '[verifyLiveSnapshot] video has no dimensions yet — camera not ready.'
      );

      return null;
    }

    const snapshot =
      this.captureSnapshot();

    if (!snapshot) {

      console.warn(
        '[verifyLiveSnapshot] captureSnapshot() returned null.'
      );

      return null;
    }

    this.logsSubject.next({

      message:
        'Live snapshot captured, comparing to registration photo...',

      severity:
        'low',

      timestamp:
        new Date().toISOString()

    });

    try {

      // =====================================================================
      // CHANGED:
      // Resize the live snapshot before face detection.
      // =====================================================================

      const liveInput =
        this.prepareCanvasForDetection(
          this.snapshotCanvas!
        );

      const liveDescriptor =
        await this.getFaceDescriptor(
          liveInput
        );

      if (!liveDescriptor) {

        console.warn(
          '[verifyLiveSnapshot] no face found in the live snapshot.'
        );

        // NEW: more specific, actionable log line instead of the generic
        // "could not be completed" message the UI was showing every time.
        this.logsSubject.next({

          message:
            'No face could be extracted from the live frame — face the camera directly with better lighting and try again.',

          severity:
            'medium',

          timestamp:
            new Date().toISOString()

        });

        return null;
      }

      const distance =
        this.faceapi.euclideanDistance(
          this.registrationDescriptor,
          liveDescriptor
        );

      const isMatch =
        distance <
        this.config.faceMatchDistanceThreshold;

      if (!isMatch) {

        this.identityMismatchActive =
          true;

        this.emitFlag(
          'identity_mismatch',
          'high',
          `Live face does not match registration photo (distance ${distance.toFixed(2)}).`
        );

      } else if (
        this.identityMismatchActive
      ) {

        this.identityMismatchActive =
          false;

        this.emitFlag(
          'identity_restored',
          'low',
          `Identity re-verified (distance ${distance.toFixed(2)}).`
        );
      }

      return {
        isMatch,
        distance,
        snapshot
      };

    } catch (error) {

      console.error(
        'Live identity verification error:',
        error
      );

      throw error;
    }
  }

  // ===========================================================================
  // NEW:
  // Pre-exam "room check". Runs Step 2.2 (unauthorized-object scan) and
  // Step 2.3 (multiple-person/headcount scan) — the same underlying checks
  // as detectObjects()/detectFace() above — for a fixed window BEFORE the
  // exam timer starts, while the candidate is asked to slowly pan the
  // camera around the room.
  //
  // This is intentionally a self-contained loop rather than a reuse of
  // detectFace()/detectObjects():
  //   - It does NOT read or write this.multiFaceActive, this.objectActive,
  //     or this.consecutiveNoFaceCount, so the room scan can never leave
  //     stale state behind that would suppress or falsely trigger a real
  //     exam-time violation once startDetection() runs afterwards.
  //   - It does NOT call emitFlag() and does NOT push to flagsSubject or
  //     logsSubject, so nothing from the room scan appears in the
  //     exam-time violation report or live console. Findings are handed
  //     back directly to the caller (return value + optional onUpdate
  //     callback) to be shown/stored as pre-exam room-check results.
  // ===========================================================================
  async runRoomCheck(
    durationMs: number,
    onUpdate?: (result: RoomCheckResult) => void,
    intervalMs: number = 1000
  ): Promise<RoomCheckResult[]> {

    const results: RoomCheckResult[] = [];

    if (
      !isPlatformBrowser(this.platformId) ||
      !this.video ||
      !this.faceapi ||
      !this.objectModel
    ) {
      return results;
    }

    const deadline = Date.now() + durationMs;

    while (Date.now() < deadline) {

      if (
        this.video.readyState >=
        HTMLMediaElement.HAVE_CURRENT_DATA
      ) {

        try {

          // Step 2.3: multiple-person / headcount scan (face-based).
          const faceDetections =
            (await this.withTimeout(

              this.faceapi.detectAllFaces(
                this.video,
                this.faceMatcherOptions
              ),

              5000,

              'runRoomCheck:faces'

            )) as any[];

          // Step 2.2 (+ person count corroboration): object/unauthorized
          // item scan.
          const predictions =
            (await this.withTimeout(

              this.objectModel.detect(
                this.video,
                this.config.maxObjectBoxes,
                this.config.objectDetectionMinScore
              ),

              5000,

              'runRoomCheck:objects'

            )) as any[];

          const suspicious =
            predictions.filter(
              (pr: any) =>
                this.config.watchedItems.includes(pr.class)
            );

          const people =
            predictions.filter(
              (pr: any) =>
                pr.class === 'person' &&
                pr.score >= this.config.personCountMinScore
            );

          const peopleCount =
            Math.max(faceDetections.length, people.length);

          const timestamp =
            new Date().toISOString();

          if (suspicious.length > 0) {

            const items =
              Array.from(
                new Set(
                  suspicious.map((pr: any) => pr.class)
                )
              ).join(', ');

            const result: RoomCheckResult = {

              message:
                `Room check: possible unauthorized item visible (${items}).`,

              severity: 'medium',

              kind: 'unauthorized_object',

              timestamp
            };

            results.push(result);

            onUpdate?.(result);
          }

          if (peopleCount > 1) {

            const result: RoomCheckResult = {

              message:
                `Room check: more than one person visible (${peopleCount}).`,

              severity: 'medium',

              kind: 'multiple_people',

              timestamp
            };

            results.push(result);

            onUpdate?.(result);
          }

        } catch (error) {

          console.error(
            'Room check detection error (loop continues):',
            error
          );
        }
      }

      await new Promise(
        resolve => setTimeout(resolve, intervalMs)
      );
    }

    if (results.length === 0) {

      const okResult: RoomCheckResult = {

        message:
          'Room check: no unauthorized items or additional people detected.',

        severity: 'low',

        kind: 'ok',

        timestamp: new Date().toISOString()
      };

      results.push(okResult);

      onUpdate?.(okResult);
    }

    return results;
  }

  async verifyIdentity(
    registrationPhotoImg: HTMLImageElement,
    loginPhotoImg: HTMLImageElement,
    governmentIdImg?: HTMLImageElement
  ): Promise<
    IdentityVerificationResult
  > {

    if (!this.faceapi) {

      throw new Error(
        'Face API not loaded'
      );
    }

    const [
      desc1,
      desc2
    ] = await Promise.all([

      this.getFaceDescriptor(
        registrationPhotoImg
      ),

      this.getFaceDescriptor(
        loginPhotoImg
      )

    ]);

    if (!desc1 || !desc2) {

      return {

        isMatch: false,

        distance: 1.0,

        snapshot: null,

        governmentIdSnapshot: null
      };
    }

    const distance =
      this.faceapi.euclideanDistance(
        desc1,
        desc2
      );

    const isMatch =
      distance <
      this.config.faceMatchDistanceThreshold;

    let governmentIdSnapshot:
      string | null = null;

    if (
      governmentIdImg &&
      isPlatformBrowser(
        this.platformId
      )
    ) {

      governmentIdSnapshot =
        this.encodeImageElement(
          governmentIdImg
        );
    }

    return {

      isMatch,

      distance,

      snapshot: null,

      governmentIdSnapshot
    };
  }

  private encodeImageElement(
    img: HTMLImageElement
  ): string | null {

    if (
      !this.snapshotCanvas ||
      !this.snapshotCtx
    ) {
      return null;
    }

    this.snapshotCanvas.width =
      img.naturalWidth || 640;

    this.snapshotCanvas.height =
      img.naturalHeight || 480;

    this.snapshotCtx.drawImage(
      img,
      0,
      0,
      this.snapshotCanvas.width,
      this.snapshotCanvas.height
    );

    return this.snapshotCanvas.toDataURL(
      'image/jpeg',
      0.8
    );
  }

  startPeriodicIdentityCheck(
    intervalMs: number =
      this.config.defaultIdentityCheckIntervalMs,

    onResult?: (
      result:
        FaceVerificationResult | null
    ) => void

  ): void {

    if (
      this.identityCheckIntervalId
    ) {
      return;
    }

    this.identityCheckIntervalId =
      setInterval(async () => {

        const result =
          await this.verifyLiveSnapshot();

        onResult?.(result);

      }, intervalMs);
  }

  stopPeriodicIdentityCheck(): void {

    if (
      this.identityCheckIntervalId
    ) {

      clearInterval(
        this.identityCheckIntervalId
      );

      this.identityCheckIntervalId =
        null;
    }
  }

  public captureSnapshot():
    string | null {

    if (
      !this.video ||
      !this.snapshotCanvas ||
      !this.snapshotCtx
    ) {
      return null;
    }

    if (
      this.video.videoWidth === 0 ||
      this.video.videoHeight === 0
    ) {
      return null;
    }

    this.snapshotCanvas.width =
      this.video.videoWidth;

    this.snapshotCanvas.height =
      this.video.videoHeight;

    this.snapshotCtx.drawImage(
      this.video,
      0,
      0
    );

    return this.snapshotCanvas.toDataURL(
      'image/jpeg',
      this.config.snapshotQuality
    );
  }

  private emitFlag(
    flagType: ProctoringFlagType,
    severity: ProctoringSeverity,
    message: string
  ): void {

    const timestamp =
      new Date().toISOString();

    const flag: ProctoringFlag = {

      candidateId:
        this.candidateId,

      examId:
        this.examId,

      flagType,

      severity,

      timestamp,

      snapshot:
        this.captureSnapshot()
    };

    console.warn(
      `[PROCTOR] ${flagType} (${severity}): ${message}`
    );

    this.flagsSubject.next(
      flag
    );

    this.logsSubject.next({

      message,

      severity,

      timestamp

    });
  }

  private setupBrowserListeners(): void {

    if (
      !isPlatformBrowser(
        this.platformId
      )
    ) {
      return;
    }

    document.addEventListener(
      'visibilitychange',
      this.visibilityHandler
    );

    window.addEventListener(
      'blur',
      this.blurHandler
    );

    window.addEventListener(
      'focus',
      this.focusHandler
    );
  }

  private teardownBrowserListeners(): void {

    if (
      !isPlatformBrowser(
        this.platformId
      )
    ) {
      return;
    }

    document.removeEventListener(
      'visibilitychange',
      this.visibilityHandler
    );

    window.removeEventListener(
      'blur',
      this.blurHandler
    );

    window.removeEventListener(
      'focus',
      this.focusHandler
    );
  }

  getStream():
    MediaStream | null {

    return this.stream;
  }

  get running(): boolean {

    return this.isRunning;
  }

  stopDetection(): void {

    this.sessionToken++;

    this.isRunning =
      false;

    this.consecutiveNoFaceCount =
      0;

    this.faceFlaggedMissing =
      false;

    this.lastFaceState =
      null;

    this.multiFaceActive =
      false;

    this.multiPersonObjActive =
      false;

    this.objectActive =
      false;
  }

  stopCamera(): void {

    this.stream
      ?.getTracks()
      .forEach(
        track => track.stop()
      );

    this.stream =
      null;

    if (this.video) {

      this.video.srcObject =
        null;

      this.video =
        null;
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