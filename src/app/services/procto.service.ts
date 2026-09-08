import { Injectable, Inject, PLATFORM_ID, OnDestroy } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Observable, Subject } from 'rxjs';
import { PROCTORING_CONFIG, ProctoringConfig } from './procto.config';
import {
  FaceVerificationResult,
  IdentityVerificationResult,
  ProctoringFlag,
  ProctoringFlagType,
  ProctoringSeverity
} from './procto.types';


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
      console.warn('🚨 [PROCTOR FLAG] tab switched (medium)');
    }
  };
  private readonly blurHandler = () => {
    this.emitFlag('window_lost_focus', 'medium');
    console.warn('🚨 [PROCTOR FLAG] window lost focus (medium)');
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
      console.error('Unable to access camera:', error);
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
      if (token !== this.sessionToken) return; // torn down mid-flight
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
      if (token !== this.sessionToken) return; // stale by the time inference finished

      if (detections.length === 0) {
        this.consecutiveNoFaceCount++;
        this.faceStatusSubject.next('no_face_detected');

        if (this.consecutiveNoFaceCount >= this.config.consecutiveMissesBeforeFlag) {
          this.emitFlag('no_face_detected', 'medium');
          console.warn('🚨 [PROCTOR FLAG] no face detected (medium)');
        }
      } else {
        this.consecutiveNoFaceCount = 0;
        this.faceStatusSubject.next('face_detected');
        console.log('Face detected, distance:', detections[0].score);

        if (detections.length > 1) {
          this.emitFlag('additional_person_detected', 'high');
            console.warn('🚨 [PROCTOR FLAG] additional person detected (high)');
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
        console.warn('🚨 [PROCTOR FLAG] unauthorized object detected (high):', suspicious.map((p: any) => p.class).join(', '));
      }

      const people = predictions.filter(
        (pr: any) => pr.class === 'person' && pr.score >= this.config.personCountMinScore
      );
      if (people.length > 1) {
        this.emitFlag('additional_person_detected', 'high');
        console.warn('🚨 [PROCTOR FLAG] additional person detected (high)');
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
      if (!liveDescriptor) return null; // no face in current frame

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
    this.sessionToken++; // invalidates any in-flight scheduleLoop iterations
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