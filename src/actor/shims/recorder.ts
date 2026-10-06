/** In-browser actor: no flight recorder (no OTel, no HAR, no fault bundles on disk). Never constructed (no outDir). */
export class FlightRecorder {
  constructor() { throw new Error("flight recorder / fault bundles are not available in the in-browser actor"); }
}
