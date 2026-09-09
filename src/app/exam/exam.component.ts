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

import {
  ProctoringService,
  RoomCheckResult
} from '../services/procto.service';

import type {
  ProctoringFlag,
  ProctoringSeverity
} from '../services/procto.types';

import {
  ProctoringLogService,
  LiveLog
} from '../services/proctoring-log.service';


interface ProctoringReport {
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: string;
}

type LiveLogType = 'info' | 'success' | 'warning' | 'error';


@Component({
  selector: 'app-exam',

  standalone: true,

  imports: [
    CommonModule
  ],

  templateUrl: './exam.component.html',

  styleUrls: [
    './exam.component.css'
  ]
})
export class ExamComponent
  implements AfterViewInit, OnDestroy {


  // =========================================================
  // CAMERA VIDEO ELEMENT
  //
  // CHANGED: back to a single @ViewChild bound to the ONE
  // <video #proctorVideo> tag in the template (the always-visible
  // "Live Camera" card). The previous @ViewChildren/syncVideoElements()
  // approach existed only because there used to be a SECOND
  // <video #proctorVideo> inside the verification card, which was
  // removed from the DOM via *ngIf once verification succeeded. That
  // second video tag has now been deleted from the template entirely,
  // so there is nothing left to keep in sync — one element holds the
  // stream for the whole exam lifetime and is never torn down.
  // =========================================================

  @ViewChild('proctorVideo')
  videoRef!: ElementRef<HTMLVideoElement>;


  // =========================================================
  // EXAM
  // =========================================================

  verificationComplete = false;

  examStarted = false;

  remainingTime = 60 * 60;


  // =========================================================
  // REGISTRATION PHOTO
  // =========================================================

  public regPhotoFile: File | null = null;

  regPhotoSrc: string | null = null;


  // =========================================================
  // CAMERA
  // =========================================================

  cameraActive = false;

  cameraError = false;


  // =========================================================
  // FACE STATUS
  // =========================================================

  faceStatusText = 'Waiting...';

  faceMatchStatus = 'Not verified';


  // =========================================================
  // VERIFICATION
  // =========================================================

  verifying = false;


  // =========================================================
  // PROCTORING FLAGS
  // =========================================================

  noFaceDetected = false;

  multiplePersonDetected = false;

  unauthorizedObjectDetected = false;

  tabSwitched = false;

  windowLostFocus = false;

  identityMismatch = false;

  identityVerified = false;


  // =========================================================
  // EXISTING REPORTS
  // =========================================================

  reports: ProctoringReport[] = [];


  // =========================================================
  // LIVE LOGS
  // =========================================================

  public liveLogs: LiveLog[] = [];


  // =========================================================
  // SUBSCRIPTIONS
  // =========================================================

  private subscriptions: Subscription[] = [];

  private logSubscription?: Subscription;


  // =========================================================
  // IDENTITY CHECK
  // =========================================================

  private identityCheckInterval:
    ReturnType<typeof setInterval> | null = null;


  // =========================================================
  // NEW: PRE-EXAM ROOM CHECK
  //
  // Runs after a successful identity match but BEFORE the exam timer
  // and normal detection loop start. Shows a "please turn your camera
  // around the room" instruction for a fixed window, during which
  // ProctoringService.runRoomCheck() runs Steps 2.2/2.3 in isolation.
  // Findings are kept in roomCheckResults — a separate array from
  // `reports` — so they are never counted as exam-time violations.
  // =========================================================

  private readonly ROOM_CHECK_DURATION_MS = 15000;

  roomCheckActive = false;

  roomCheckSecondsRemaining = 0;

  roomCheckResults: RoomCheckResult[] = [];

  private roomCheckCountdownInterval:
    ReturnType<typeof setInterval> | null = null;


  // =========================================================
  // CONSTRUCTOR
  // =========================================================

  constructor(
    private proctoringService: ProctoringService,

    private zone: NgZone,

    private logService: ProctoringLogService
  ) {}


  // =========================================================
  // AFTER VIEW INIT
  // =========================================================

  async ngAfterViewInit(): Promise<void> {

    try {

      console.log(
        '[EXAM] Initializing exam...'
      );


      // -------------------------------------------------------
      // Candidate / Exam IDs
      // -------------------------------------------------------

      const candidateId = 'candidate-001';

      const examId = 'exam-001';


      // -------------------------------------------------------
      // Initialize proctoring service
      // -------------------------------------------------------

      await this.proctoringService.initialize();


      // -------------------------------------------------------
      // Face status subscription
      // -------------------------------------------------------

      const faceStatusSubscription =
        this.proctoringService.faceStatus$
          .subscribe(status => {

            this.zone.run(() => {

              const detected = status === 'face_detected';

              this.faceStatusText =
                detected
                  ? 'Face detected'
                  : 'No face detected';

              this.noFaceDetected = !detected;

            });

          });


      this.subscriptions.push(
        faceStatusSubscription
      );


      // -------------------------------------------------------
      // Proctoring flags subscription — drives the sticky status
      // booleans (noFaceDetected, tabSwitched, etc.). Uses the
      // ACTUAL ProctoringFlag shape (flag.flagType, lowercase
      // snake_case values) rather than a made-up flag.type/UPPER_CASE
      // scheme, which previously meant no case ever matched and every
      // real proctoring event was silently dropped.
      // -------------------------------------------------------

      const flagSubscription =
        this.proctoringService.flags$
          .subscribe(flag => {

            this.zone.run(() => {

              this.handleProctoringFlag(flag);

            });

          });


      this.subscriptions.push(
        flagSubscription
      );


      // -------------------------------------------------------
      // Existing logs subscription — the same human-readable
      // messages procto.service already console.warn's. These now
      // ALSO get forwarded into the on-screen live console below, so
      // what you see on screen matches what's in devtools.
      // -------------------------------------------------------

      const reportSubscription =
        this.proctoringService.logs$
          .subscribe(log => {

            this.zone.run(() => {

              this.addReport({

                message: log.message,

                severity:
                  log.severity as
                  'low' |
                  'medium' |
                  'high' |
                  'critical',

                timestamp: log.timestamp

              });

              // Mirror this exact event into the live console panel.
              this.logService.log(
                log.message,
                this.toLiveLogType(log.severity, log.message)
              );

            });

          });


      this.subscriptions.push(
        reportSubscription
      );


      // -------------------------------------------------------
      // NEW LIVE LOG SERVICE
      // -------------------------------------------------------

      this.logSubscription =
        this.logService.logs$
          .subscribe(logs => {

            this.zone.run(() => {

              this.liveLogs = logs;

            });

          });


      // -------------------------------------------------------
      // Start camera
      // -------------------------------------------------------

      await this.startCamera();

    }
    catch (error) {

      console.error(
        '[EXAM] Initialization error:',
        error
      );

      this.cameraError = true;

      this.logService.log(
        'Exam initialization failed.',
        'error'
      );

    }

  }


  // =========================================================
  // CAMERA
  // =========================================================

  async startCamera(): Promise<void> {

    try {

      const videoElement =
        this.videoRef?.nativeElement;

      if (!videoElement) {

        console.error(
          '[EXAM] Video element not available.'
        );

        return;

      }


      await this.proctoringService
        .startCamera(videoElement);


      this.cameraActive = true;

      this.cameraError = false;


      this.logService.log(
        'Camera started successfully.',
        'success'
      );


      console.log(
        '[EXAM] Camera started.'
      );

    }
    catch (error) {

      console.error(
        '[EXAM] Camera error:',
        error
      );

      this.cameraActive = false;

      this.cameraError = true;


      this.logService.log(
        'Camera access failed.',
        'error'
      );

    }

  }


  // =========================================================
  // REGISTRATION PHOTO SELECT
  // =========================================================

  onRegistrationPhotoSelected(
    event: Event
  ): void {

    const input =
      event.target as HTMLInputElement;


    if (
      !input.files ||
      input.files.length === 0
    ) {
      return;
    }


    this.regPhotoFile =
      input.files[0];


    const reader =
      new FileReader();


    reader.onload = () => {

      this.zone.run(() => {

        this.regPhotoSrc =
          reader.result as string;

      });

    };


    reader.readAsDataURL(
      this.regPhotoFile
    );


    this.logService.log(
      'Registration photo selected.',
      'info'
    );

  }


  // =========================================================
  // VERIFY AND START EXAM
  //
  // Verification is now a HARD GATE again: the exam only starts on a
  // successful identity match. On a mismatch, a failed comparison, or
  // an error, the verification card stays open (verificationComplete
  // stays false) and `verifying` is reset to false in `finally`, so the
  // "Verify & Start Exam" button becomes clickable again — the user can
  // retry with the same or a different photo.
  // =========================================================

  async verifyAndStartExam(): Promise<void> {

    if (!this.regPhotoFile) {

      this.logService.log(
        'Please select a registration photo.',
        'warning'
      );

      return;

    }


    if (!this.cameraActive) {

      this.logService.log(
        'Camera is not active.',
        'error'
      );

      return;

    }


    this.verifying = true;

    this.faceMatchStatus =
      'Verifying...';


    this.logService.log(
      'Starting identity verification.',
      'info'
    );


    try {

      // -------------------------------------------------------
      // Set registration photo
      // -------------------------------------------------------

      const registered =
        await this.proctoringService
          .setRegistrationPhoto(
            this.regPhotoFile
          );

      if (registered) {

        this.logService.log(
          'Registration face descriptor created.',
          'success'
        );

      } else {

        this.logService.log(
          'No face could be detected in the registration photo.',
          'warning'
        );

      }


      // -------------------------------------------------------
      // Verify live snapshot. NOTE: verifyLiveSnapshot() returns a
      // result object whenever a comparison was possible, EVEN IF the
      // faces don't match (isMatch: false) — it only returns null when
      // no comparison could be attempted at all (no face in frame, no
      // registration descriptor, etc).
      // -------------------------------------------------------

      const result =
        await this.proctoringService
          .verifyLiveSnapshot();

      const matched = !!result && result.isMatch;

      if (matched) {

        this.identityVerified = true;

        this.identityMismatch = false;

        this.faceMatchStatus =
          `Identity verified (distance ${result!.distance.toFixed(2)})`;

        this.logService.log(
          'Identity verification successful.',
          'success'
        );

      } else if (result) {

        // A comparison was made but didn't match closely enough.
        // Do NOT start the exam — keep the verification card open so
        // the user can retry.
        this.identityVerified = false;

        this.identityMismatch = true;

        this.faceMatchStatus =
          `Not verified — mismatch (distance ${result.distance.toFixed(2)}). Please try again.`;

        this.logService.log(
          'Identity verification did not match the registration photo. Please try again.',
          'warning'
        );

        return;

      } else {

        // No comparison could be made (e.g. no face visible right now,
        // or the registration photo had no detectable face). Do NOT
        // start the exam — keep the verification card open so the
        // user can retry.
        this.identityVerified = false;

        this.identityMismatch = true;

        this.faceMatchStatus =
          'Not verified — no face available for comparison. Please try again.';

        this.logService.log(
          'Identity verification could not be completed. Please try again.',
          'warning'
        );

        return;

      }


      // -------------------------------------------------------
      // Only reached on a successful match. The exam no longer starts
      // immediately here — a pre-exam room check runs first. The
      // exam-start logic that used to run at this point is unchanged;
      // it has simply moved, verbatim, into beginExamAfterRoomCheck()
      // below, and now runs once the room check window finishes.
      // -------------------------------------------------------

      this.verificationComplete = true;

      await this.startRoomCheck();

    }
    catch (error) {

      console.error(
        '[EXAM] Verification error:',
        error
      );


      this.faceMatchStatus =
        'Verification error — please try again.';


      this.identityMismatch = true;

      this.identityVerified = false;


      this.logService.log(
        'Identity verification encountered an error. Please try again.',
        'error'
      );

      // Do NOT start the exam on error — keep the verification card
      // open so the user can retry.

    }
    finally {

      this.verifying = false;

    }

  }


  // =========================================================
  // NEW: PRE-EXAM ROOM CHECK
  //
  // Shows the "please slowly turn your camera around the room"
  // instruction for ROOM_CHECK_DURATION_MS, running Steps 2.2/2.3 only
  // during that window via ProctoringService.runRoomCheck(). Results
  // are stored in roomCheckResults (not `reports`), so they render as
  // a distinct "pre-exam room check" outcome rather than exam-time
  // violations. Once the window ends, beginExamAfterRoomCheck() starts
  // the exam exactly as verifyAndStartExam() used to do right after a
  // successful match.
  // =========================================================

  private async startRoomCheck(): Promise<void> {

    this.roomCheckActive = true;

    this.roomCheckResults = [];

    this.roomCheckSecondsRemaining =
      Math.ceil(this.ROOM_CHECK_DURATION_MS / 1000);

    this.logService.log(
      'Please slowly turn your camera around the room.',
      'info'
    );

    this.roomCheckCountdownInterval =
      setInterval(() => {

        this.zone.run(() => {

          this.roomCheckSecondsRemaining =
            Math.max(0, this.roomCheckSecondsRemaining - 1);

        });

      }, 1000);

    const results =
      await this.proctoringService.runRoomCheck(
        this.ROOM_CHECK_DURATION_MS,
        (result) => {

          this.zone.run(() => {

            this.roomCheckResults =
              [result, ...this.roomCheckResults].slice(0, 50);

          });

        }
      );

    if (this.roomCheckCountdownInterval) {

      clearInterval(this.roomCheckCountdownInterval);

      this.roomCheckCountdownInterval = null;

    }

    const flaggedCount =
      results.filter(r => r.kind !== 'ok').length;

    this.logService.log(

      flaggedCount > 0
        ? `Room check complete — ${flaggedCount} item(s) flagged for review (pre-exam, not counted as exam violations).`
        : 'Room check complete — no issues found.',

      flaggedCount > 0 ? 'warning' : 'success'

    );

    this.roomCheckActive = false;

    await this.beginExamAfterRoomCheck();

  }


  // =========================================================
  // NEW: exam-start logic, unchanged from the block that used to run
  // directly inside verifyAndStartExam() right after a successful
  // identity match — only its trigger point has moved.
  // =========================================================

  private async beginExamAfterRoomCheck(): Promise<void> {

    this.examStarted = true;


    // -----------------------------------------------------
    // Start detection
    // -----------------------------------------------------

    this.proctoringService
      .startDetection();


    this.logService.log(
      'AI proctoring detection started.',
      'success'
    );


    // -----------------------------------------------------
    // Start live logs — prints a real status snapshot every
    // second (face/person/object/tab/identity), not a static
    // filler string.
    // -----------------------------------------------------

    this.logService.startLiveLogs(
      () => this.buildStatusSnapshot()
    );


    // -----------------------------------------------------
    // Start periodic identity verification
    // -----------------------------------------------------

    this.startPeriodicIdentityCheck();

  }


  // =========================================================
  // PERIODIC IDENTITY CHECK
  // =========================================================

  private startPeriodicIdentityCheck(): void {

    if (this.identityCheckInterval) {

      clearInterval(
        this.identityCheckInterval
      );

    }


    this.identityCheckInterval =
      setInterval(async () => {

        if (!this.examStarted) {
          return;
        }


        try {

          this.logService.log(
            'Periodic identity verification started.',
            'info'
          );


          const result =
            await this.proctoringService
              .verifyLiveSnapshot();

          const matched = !!result && result.isMatch;


          if (matched) {

            this.identityVerified = true;

            this.identityMismatch = false;


            this.logService.log(
              'Periodic identity verification passed.',
              'success'
            );

          }
          else {

            this.identityVerified = false;

            this.identityMismatch = true;


            this.logService.log(
              'Periodic identity verification failed.',
              'error'
            );

          }

        }
        catch (error) {

          console.error(
            '[EXAM] Periodic identity check error:',
            error
          );

          this.logService.log(
            'Periodic identity verification error.',
            'error'
          );

        }

      }, 5 * 60 * 1000);

  }


  // =========================================================
  // HANDLE PROCTORING FLAG
  //
  // Matches the ACTUAL ProctoringFlag shape from procto.service.ts:
  // `flag.flagType`, lowercase snake_case values. The previous switch
  // used `flag.type` with UPPER_CASE values that never occurred in the
  // real flag objects, so this never fired for any real event.
  // =========================================================

  handleProctoringFlag(flag: ProctoringFlag): void {

    console.log(
      '[PROCTORING FLAG]',
      flag
    );


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

        this.unauthorizedObjectDetected =
          true;

        break;


      case 'object_cleared':

        this.unauthorizedObjectDetected =
          false;

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


      case 'identity_mismatch':

        this.identityMismatch = true;

        this.identityVerified = false;

        break;


      case 'identity_restored':

        this.identityMismatch = false;

        this.identityVerified = true;

        break;


      case 'camera_error':

        this.cameraActive = false;

        this.cameraError = true;

        break;

    }

  }


  // =========================================================
  // ADD REPORT
  // =========================================================

  addReport(
    report: ProctoringReport
  ): void {

    this.reports = [
      report,
      ...this.reports
    ].slice(0, 100);

  }


  // =========================================================
  // LIVE STATUS SNAPSHOT
  // Built fresh every second by ProctoringLogService's heartbeat, so
  // the "every second" log line actually reflects current state
  // instead of repeating a fixed placeholder string.
  // =========================================================

  private buildStatusSnapshot(): { message: string; type: LiveLogType } {

    const issues: string[] = [];

    if (this.noFaceDetected) issues.push('no face detected');
    if (this.multiplePersonDetected) issues.push('multiple people in frame');
    if (this.unauthorizedObjectDetected) issues.push('unauthorized object visible');
    if (this.tabSwitched) issues.push('exam tab not focused');
    if (this.windowLostFocus) issues.push('exam window not focused');
    if (this.identityMismatch) issues.push('identity not verified');

    if (issues.length === 0) {
      return {
        message: 'Status OK — face visible, single candidate, no restricted items, tab focused.',
        type: 'success'
      };
    }

    return {
      message: `Active alerts: ${issues.join(', ')}.`,
      type: 'error'
    };

  }


  // =========================================================
  // Map a ProctoringSeverity + message to a live-console log type
  // =========================================================

  private toLiveLogType(
    severity: ProctoringSeverity,
    message: string
  ): LiveLogType {

    const recovered = /restored|cleared|again|verified|matched|started/i.test(message);

    if (recovered) return 'success';
    if (severity === 'high') return 'error';
    if (severity === 'medium') return 'warning';
    return 'info';

  }


  // =========================================================
  // CLEAR LIVE LOGS
  // =========================================================

  clearLiveLogs(): void {

    this.logService.clear();

  }


  // =========================================================
  // REFRESH LIVE LOGS
  // Pulls the current logs snapshot from the log service again and
  // re-assigns it, forcing the console panel to re-render immediately
  // rather than waiting for the next natural emission.
  // =========================================================

  refreshLogs(): void {

    this.liveLogs = [
      ...this.logService.currentLogs
    ];

  }


  // =========================================================
  // SEVERITY ICON
  // =========================================================

  getSeverityIcon(
    severity: string
  ): string {

    switch (severity) {

      case 'critical':
        return '🚨';

      case 'high':
        return '⚠️';

      case 'medium':
        return '⚠';

      case 'low':
      default:
        return 'ℹ';

    }

  }


  // =========================================================
  // SEVERITY CLASS
  // =========================================================

  getSeverityClass(
    severity: string
  ): string {

    return `severity-${severity}`;

  }


  // =========================================================
  // TIMER
  // =========================================================

  get formattedTime(): string {

    const hours =
      Math.floor(
        this.remainingTime / 3600
      );

    const minutes =
      Math.floor(
        (this.remainingTime % 3600) / 60
      );

    const seconds =
      this.remainingTime % 60;


    return [
      hours.toString().padStart(2, '0'),

      minutes.toString().padStart(2, '0'),

      seconds.toString().padStart(2, '0')

    ].join(':');

  }


  // =========================================================
  // DESTROY
  // =========================================================

  ngOnDestroy(): void {

    // Stop room-check countdown timer
    if (this.roomCheckCountdownInterval) {

      clearInterval(
        this.roomCheckCountdownInterval
      );

      this.roomCheckCountdownInterval = null;

    }


    // Stop identity timer
    if (this.identityCheckInterval) {

      clearInterval(
        this.identityCheckInterval
      );

      this.identityCheckInterval = null;

    }


    // Stop live log heartbeat
    this.logService.stopLiveLogs();


    // Unsubscribe live log subscription
    this.logSubscription?.unsubscribe();


    // Unsubscribe other subscriptions
    this.subscriptions.forEach(
      subscription =>
        subscription.unsubscribe()
    );


    // Stop proctoring
    this.proctoringService
      .stopProctoring();

  }

}