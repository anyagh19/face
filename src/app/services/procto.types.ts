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
  /** Full-resolution JPEG data URL, or null if a frame wasn't available. */
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