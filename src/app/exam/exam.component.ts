import { Component, ElementRef, OnDestroy, ViewChild, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProctoringService } from '../services/procto.service';

@Component({
  selector: 'app-exam',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './exam.component.html',
  styleUrl: './exam.component.css'
})
export class ExamComponent implements OnDestroy, AfterViewInit {
  @ViewChild('proctorVideo') videoElement!: ElementRef<HTMLVideoElement>;

  public verificationComplete = false;
  public regPhotoSrc: string | null = null;
  public govIdSrc: string | null = null;
  public cameraActive = false;
  public faceStatusText = 'Waiting for identity verification...';
  public faceMatchStatus = 'Pending';

  private regPhotoFile: File | null = null;
  private regPhotoStored = false; // true once ProctoringService has the descriptor

  constructor(private proctoringService: ProctoringService) {}

  async ngAfterViewInit(): Promise<void> {
    this.proctoringService.candidateId = 'CANDIDATE_9901';
    this.proctoringService.examId = 'EXAM_5542';

    console.log('Initializing proctoring service modules...');
    const initialized = await this.proctoringService.initialize();
    if (!initialized) {
      console.error('Proctoring initialization failed');
      return;
    }

    const cameraStarted = await this.proctoringService.startCamera(
      this.videoElement.nativeElement
    );

    if (cameraStarted) {
      this.cameraActive = true;
    }
  }

  onFileSelected(event: any, type: 'reg' | 'id'): void {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e: any) => {
      if (type === 'reg') {
        this.regPhotoSrc = e.target.result;
      } else {
        this.govIdSrc = e.target.result;
      }
    };
    reader.readAsDataURL(file);

    if (type === 'reg') {
      this.regPhotoFile = file;
      this.regPhotoStored = false; // will be (re)stored on next verify, or immediately below
    }
  }

  async verifyAndStartExam(): Promise<void> {
    if (!this.regPhotoSrc || !this.regPhotoFile) return;

    this.faceStatusText = 'Verifying facial match...';

    try {
      // Store the registration descriptor in the service (this is what
      // verifyLiveSnapshot() and the periodic checks compare against).
      this.regPhotoStored = await this.proctoringService.setRegistrationPhoto(this.regPhotoFile);

      if (!this.regPhotoStored) {
        this.faceMatchStatus = 'No face found in registration photo';
        this.faceStatusText = 'Please upload a clearer registration photo.';
        return;
      }

      // Compare the registration photo against the CURRENT live camera frame.
      const result = await this.proctoringService.verifyLiveSnapshot();

      if (!result) {
        this.faceMatchStatus = 'No face detected in camera';
        this.faceStatusText = 'Position your face clearly in frame and try again.';
        return;
      }

      this.faceMatchStatus = result.isMatch
        ? `Matched (Dist: ${result.distance.toFixed(2)})`
        : `Mismatch (Dist: ${result.distance.toFixed(2)})`;

      this.verificationComplete = true;
      this.faceStatusText = 'Monitoring Active';

      this.proctoringService.startDetection();

      // Keep re-checking identity throughout the exam (every 5 min by
      // default), updating the same UI fields each time a check runs.
      this.proctoringService.startPeriodicIdentityCheck(5 * 60 * 1000, (liveResult) => {
        if (!liveResult) {
          this.faceMatchStatus = 'No face detected';
          return;
        }
        this.faceMatchStatus = liveResult.isMatch
          ? `Matched (Dist: ${liveResult.distance.toFixed(2)})`
          : `Mismatch (Dist: ${liveResult.distance.toFixed(2)})`;
      });

    } catch (err) {
      console.error('Identity verification error:', err);
      this.faceStatusText = 'Verification failed. Starting anyway.';
      this.verificationComplete = true;
      this.proctoringService.startDetection();
    }
  }

  ngOnDestroy(): void {
    this.proctoringService.stopProctoring();
  }
}