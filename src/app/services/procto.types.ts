export type ProctoringFlagType =
  | 'no_face_detected'
  | 'face_restored'              // NEW: fired once when a face reappears after being flagged missing
  | 'additional_person_detected'
  | 'person_left'                // NEW: fired once when the extra person leaves frame
  | 'unauthorized_object'
  | 'object_cleared'             // NEW: fired once when the restricted item is no longer visible
  | 'tab_switched'
  | 'tab_restored'               // NEW: fired once when the candidate returns to the exam tab
  | 'window_lost_focus'
  | 'window_focus_restored'      // NEW: fired once when the exam window regains focus
  | 'identity_mismatch'
  | 'identity_restored'          // NEW: fired once when a later identity check matches again
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

/**
 * A single human-readable console-style entry. Emitted by the service on
 * every meaningful STATE CHANGE (not on every polling tick), so the UI can
 * render a real event log instead of a spam of repeated status lines.
 */
export interface DetectionLogEntry {
  message: string;
  severity: ProctoringSeverity;
  timestamp: string;
}