/** The time, as a port so a test can fix it. @public */
export interface Clock {
  now(): Date;
}
