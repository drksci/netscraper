/** In-browser actor: domhash drift checks are disabled (domhash needs Node crypto). Capture returns null → no check. */
export const capturePage = async () => null;
export const fingerprintPage = async () => null;
export const fingerprintCaptured = async () => { throw new Error("drift checks disabled in the in-browser actor"); };
export const similarity = () => 1;
export const structuralDiff = () => [];
