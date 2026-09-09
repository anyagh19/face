import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild
} from '@angular/core';

import { CommonModule } from '@angular/common';

import { Subscription } from 'rxjs';

import { ProctoringService } from '../services/procto.service';

import {
  ProctoringFlag,
  ProctoringSeverity,
  DetectionLogEntry
} from '../services/procto.types';

interface ProctoringReport {
  message: string;
  severity: ProctoringSeverity;
  timestamp: Date;
}

@Component({
  selector: 'app-exam',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './exam.component.html',
  styleUrl: './exam.component.css'
})
export class ExamComponent implements AfterViewInit, OnDestroy {

  @ViewChild('proctorVideo')
  videoElement!: ElementRef<HTMLVideoElement>;

  // ============================================================
  // EXAM STATE
  // ============================================================

  public verificationComplete = false;
  public regPhotoSrc: string | null = null;
  public cameraActive = false;
  public faceStatusText = 'Waiting for identity verification...';
  public faceMatchStatus = 'Pending';
  public verifying = false;

  // ============================================================
  // REPORT / ALERT STATE
  // These are pure "is this currently a problem?" flags for the status
  // panel. They are set true when a violation flag comes in and set back
  // to false when the matching *_restored / *_cleared flag comes in — see
  // handleProctoringFlag(). They no longer get stuck "on" forever.
  // ============================================================

  public reports: ProctoringReport[] = [];
  public noFaceDetected = false;
  public multiplePersonDetected = false;
  public unauthorizedObjectDetected = false;
  public tabSwitched = false;
  public windowLostFocus = false;
  public identityMismatch = false;
  public cameraError = false;

  // ============================================================
  // INTERNAL
  // ============================================================

  public regPhotoFile: File | null = null;
  private regPhotoStored = false;
  private subscriptions: Subscription[] = [];

  constructor(
    private proctoringService: ProctoringService,
    private zone: NgZone
  ) {}

  // ============================================================
  // INITIALIZE
  // ============================================================

  async ngAfterViewInit(): Promise<void> {
    this.proctoringService.candidateId = 'CANDIDATE_9901';
    this.proctoringService.examId = 'EXAM_5542';

    console.log('Initializing proctoring service modules...');
    const initialized = await this.proctoringService.initialize();
    if (!initialized) {
      this.faceStatusText = 'Proctoring initialization failed';
      console.error('Proctoring initialization failed');
      return;
    }

    // Live face-present/absent text for the camera card. This fires only
    // on actual change (the service no longer emits on every poll tick),
    // so it's cheap to bind directly without extra debouncing here.
    this.subscriptions.push(
      this.proctoringService.faceStatus$.subscribe(status => {
        this.zone.run(() => {
          this.faceStatusText =
            status === 'face_detected' ? 'Face detected' : '⚠ No face detected';
        });
      })
    );

    // Structured flags → drive the sticky status indicators only.
    this.subscriptions.push(
      this.proctoringService.flags$.subscribe(flag => {
        this.zone.run(() => {
          this.handleProctoringFlag(flag);
        });
      })
    );

    // Human-readable log entries → drive the "Proctoring Report" list.
    // This is the ONE place reports get added, so nothing gets logged
    // twice and nothing gets logged on a fixed timer regardless of
    // whether anything actually happened.
    this.subscriptions.push(
      this.proctoringService.logs$.subscribe((entry: DetectionLogEntry) => {
        this.zone.run(() => {
          this.addReport(entry.message, entry.severity, entry.timestamp);
        });
      })
    );

    // Start camera
    const cameraStarted = await this.proctoringService.startCamera(
      this.videoElement.nativeElement
    );
    if (cameraStarted) {
      this.cameraActive = true;
      this.faceStatusText = 'Camera active. Upload your registration photo.';
    } else {
      this.cameraActive = false;
      this.cameraError = true;
      this.faceStatusText = 'Camera access failed — check the browser console for the specific reason.';
    }
  }

  // ============================================================
  // REGISTRATION PHOTO
  // ============================================================

  onRegistrationPhotoSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.regPhotoFile = file;
    const reader = new FileReader();
    reader.onload = () => {
      this.regPhotoSrc = reader.result as string;
    };
    reader.readAsDataURL(file);
    this.regPhotoStored = false;
    this.faceMatchStatus = 'Registration photo selected';
  }

  // ============================================================
  // VERIFY + START EXAM
  // The exam ONLY becomes available (verificationComplete = true) if the
  // registration photo's face descriptor matches the live camera snapshot.
  // Every other path (no photo, no face found, mismatch, error) returns
  // early and verificationComplete stays false.
  // ============================================================

  async verifyAndStartExam(): Promise<void> {
    if (!this.regPhotoSrc || !this.regPhotoFile || !this.cameraActive) {
      return;
    }

    this.verifying = true;
    this.faceStatusText = 'Verifying your identity...';
    this.faceMatchStatus = 'Verifying';

    try {
      // Store registration face descriptor
      this.regPhotoStored = await this.proctoringService.setRegistrationPhoto(
        this.regPhotoFile
      );
      if (!this.regPhotoStored) {
        this.faceMatchStatus = 'Registration photo has no detectable face';
        this.faceStatusText =
          'Please upload a clear photo containing your face — make sure the whole face is visible and well lit.';
        return;
      }

      // Compare registration photo with live camera. This is the single
      // source of truth for match/mismatch — it also emits the
      // identity_mismatch / identity_restored flag+log entry internally,
      // so we must NOT log the result again here (that used to create a
      // duplicate report entry for the same event).
      const result = await this.proctoringService.verifyLiveSnapshot();
      if (!result) {
        this.faceMatchStatus = 'No face detected in camera';
        this.faceStatusText =
          'Position your face clearly inside the camera frame and try again.';
        return;
      }

      if (result.isMatch) {
        this.faceMatchStatus = `Matched (${result.distance.toFixed(2)})`;
        this.faceStatusText = 'Identity verified. Monitoring started.';
        this.identityMismatch = false;
        this.verificationComplete = true;

        // Start continuous monitoring — the exam question only renders
        // once verificationComplete is true (see template's *ngIf).
        this.proctoringService.startDetection();

        // Periodic re-checks during the exam. Each result still flows
        // through verifyLiveSnapshot(), so match/mismatch state and
        // logging stay consistent with the initial check.
        this.proctoringService.startPeriodicIdentityCheck(
          5 * 60 * 1000,
          liveResult => {
            this.zone.run(() => {
              if (!liveResult) {
                this.faceMatchStatus = 'No face detected';
                return;
              }
              this.faceMatchStatus = liveResult.isMatch
                ? `Matched (${liveResult.distance.toFixed(2)})`
                : `Mismatch (${liveResult.distance.toFixed(2)})`;
            });
          }
        );
      } else {
        this.faceMatchStatus = `Mismatch (${result.distance.toFixed(2)})`;
        this.faceStatusText =
          'Identity verification failed — your live photo does not match the registration photo. Try re-uploading a clearer photo or repositioning the camera, then verify again.';
        this.identityMismatch = true;
        // No manual addReport() here — verifyLiveSnapshot() already
        // emitted the identity_mismatch flag, which the logs$ subscription
        // above turns into a report entry. Adding one here too was the
        // duplicate-log bug.
      }
    } catch (error) {
      console.error('Identity verification error:', error);
      this.faceStatusText =
        'Identity verification failed due to an error. Please try again.';
    } finally {
      this.verifying = false;
    }
  }

  // ============================================================
  // HANDLE FLAGS — updates the sticky status booleans only.
  // Report-list entries are handled entirely by the logs$ subscription
  // above, so this switch never calls addReport().
  // ============================================================

  private handleProctoringFlag(flag: ProctoringFlag): void {
    switch (flag.flagType) {
      case 'no_face_detected':
        this.noFaceDetected = true;
        break;
      case 'face_restored':
        this.noFaceDetected = false;
        break;

      case 'additional_person_detected':
        this.multiplePersonDetected = true;
        break;
      case 'person_left':
        this.multiplePersonDetected = false;
        break;

      case 'unauthorized_object':
        this.unauthorizedObjectDetected = true;
        break;
      case 'object_cleared':
        this.unauthorizedObjectDetected = false;
        break;

      case 'identity_mismatch':
        this.identityMismatch = true;
        this.faceMatchStatus = 'Identity mismatch';
        break;
      case 'identity_restored':
        this.identityMismatch = false;
        break;

      case 'tab_switched':
        this.tabSwitched = true;
        break;
      case 'tab_restored':
        this.tabSwitched = false;
        break;

      case 'window_lost_focus':
        this.windowLostFocus = true;
        break;
      case 'window_focus_restored':
        this.windowLostFocus = false;
        break;

      case 'camera_error':
        this.cameraError = true;
        this.cameraActive = false;
        break;
    }
  }

  // ============================================================
  // ADD REPORT (creates a new array reference to ensure UI update)
  // ============================================================

  private addReport(message: string, severity: ProctoringSeverity, timestamp?: string): void {
    const newEntry: ProctoringReport = {
      message,
      severity,
      timestamp: timestamp ? new Date(timestamp) : new Date()
    };

    // Create a new array (immutable update) to force change detection
    this.reports = [newEntry, ...this.reports];

    // Keep only latest 100 entries
    if (this.reports.length > 100) {
      this.reports = this.reports.slice(0, 100);
    }
  }

  // ============================================================
  // CLEAR INDIVIDUAL WARNING
  // ============================================================

  clearWarnings(): void {
    this.noFaceDetected = false;
    this.multiplePersonDetected = false;
    this.unauthorizedObjectDetected = false;
    this.tabSwitched = false;
    this.windowLostFocus = false;
    this.identityMismatch = false;
    this.cameraError = false;
    this.reports = [];
  }

  // ============================================================
  // REPORT HELPERS
  // ============================================================

  getReportClass(severity: ProctoringSeverity): string {
    return severity.toLowerCase();
  }

  getReportIcon(message: string): string {
    const m = message.toLowerCase();
    if (
      m.includes('restored') ||
      m.includes('cleared') ||
      m.includes('again') ||
      m.includes('re-verified') ||
      m.includes('only one person') ||
      m.includes('monitoring started')
    ) {
      return '✅';
    }
    if (m.includes('face')) return '👤';
    if (m.includes('people') || m.includes('person')) return '👥';
    if (m.includes('object') || m.includes('item') || m.includes('phone')) return '📱';
    if (m.includes('tab') || m.includes('window')) return '🖥️';
    if (m.includes('camera')) return '📷';
    return '⚠️';
  }

  // ============================================================
  // CLEANUP
  // ============================================================

  ngOnDestroy(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.proctoringService.stopProctoring();
  }
}