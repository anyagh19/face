import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export interface LiveLog {
  message: string;
  timestamp: Date;
  type: 'info' | 'success' | 'warning' | 'error';
}

export type LiveLogType = LiveLog['type'];

@Injectable({
  providedIn: 'root'
})
export class ProctoringLogService implements OnDestroy {

  private readonly logsSubject = new BehaviorSubject<LiveLog[]>([]);

  readonly logs$: Observable<LiveLog[]> =
    this.logsSubject.asObservable();

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private monitoring = false;

  /**
   * Synchronous snapshot of the current logs, for consumers that want to
   * pull the latest value on demand (e.g. a manual "Refresh" button)
   * rather than only reacting to the next emission on logs$.
   */
  get currentLogs(): LiveLog[] {
    return this.logsSubject.value;
  }

  /**
   * Add a log to the live console
   */
  log(
    message: string,
    type: LiveLogType = 'info'
  ): void {

    const entry: LiveLog = {
      message,
      timestamp: new Date(),
      type
    };

    // Also print in browser console
    console.log(`[PROCTOR] ${message}`);

    const currentLogs = this.logsSubject.value;

    this.logsSubject.next([
      ...currentLogs,
      entry
    ].slice(-100));
  }

  /**
   * Start one-second heartbeat logs.
   *
   * If `statusProvider` is supplied, it's called every second and its
   * result is what actually gets logged — this lets the caller (the exam
   * component) print a real, current status snapshot (face/person/object/
   * tab/identity) each second instead of a fixed placeholder string that
   * never changes.
   */
  startLiveLogs(
    statusProvider?: () => { message: string; type: LiveLogType }
  ): void {

    if (this.monitoring) {
      return;
    }

    this.monitoring = true;

    this.log(
      'Live monitoring started.',
      'success'
    );

    this.intervalId = setInterval(() => {

      if (!this.monitoring) {
        return;
      }

      if (statusProvider) {

        const snapshot = statusProvider();

        this.log(snapshot.message, snapshot.type);

      } else {

        this.log(
          'Proctoring system active — checking camera, face and objects.',
          'info'
        );

      }

    }, 1000);
  }

  /**
   * Stop live logging
   */
  stopLiveLogs(): void {

    if (!this.monitoring) {
      return;
    }

    this.monitoring = false;

    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.log(
      'Live monitoring stopped.',
      'warning'
    );
  }

  /**
   * Clear logs displayed on screen
   */
  clear(): void {
    this.logsSubject.next([]);
  }

  /**
   * Destroy service
   */
  ngOnDestroy(): void {

    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.monitoring = false;
  }
}