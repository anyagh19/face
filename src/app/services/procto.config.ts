import { InjectionToken } from '@angular/core';

/**
 * All tunable behavior lives here instead of hardcoded in the service.
 * This makes the service testable (inject a fake config in specs),
 * environment-configurable (different thresholds for staging vs prod
 * without touching service code), and self-documenting.
 */
export interface ProctoringConfig {
  /** Base URL the face-api models are served from (e.g. Angular's /assets path). */
  modelUrl: string;

  /** coco-ssd object classes that should trigger an 'unauthorized_object' flag. */
  watchedItems: string[];

  /** Minimum confidence (0-1) coco-ssd predictions must clear to be considered at all. */
  objectDetectionMinScore: number;

  /**
   * Minimum confidence specifically for counting `person` boxes. Kept higher
   * than objectDetectionMinScore because at low thresholds a single person
   * can produce multiple overlapping low-confidence boxes (face region,
   * torso region, etc.) that look like several people if not filtered.
   */
  personCountMinScore: number;

  /** How often (ms) to run the face-presence check. */
  faceCheckIntervalMs: number;

  /** How often (ms) to run the object/person-count check. */
  objectCheckIntervalMs: number;

  /**
   * Consecutive missed-face checks required before actually flagging
   * 'no_face_detected'. A single missed frame (blink, brief head turn,
   * momentary camera hiccup) is normal and shouldn't fire an alert; this
   * debounces that noise. With the default interval of 1000ms, a value of
   * 3 means "flag only if no face was seen for ~3 consecutive seconds."
   */
  consecutiveMissesBeforeFlag: number;

  /** Euclidean distance below which two face descriptors are considered a match. */
  faceMatchDistanceThreshold: number;

  /** Default interval (ms) for periodic identity re-verification during an exam. */
  defaultIdentityCheckIntervalMs: number;

  /** JPEG quality (0-1) used when encoding snapshots attached to flags. */
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