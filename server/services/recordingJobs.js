/**
 * What the recording jobs are busy with, shared by recordingPost.js (compression, break
 * detection), recordingMedia.js (preparation) and recordingEngine.js (capture), so none of
 * them has to require another in a circle. Each job leaves the others' recording alone.
 */
module.exports = {
    compressing: null,  // the recording being compressed
    detecting: null,    // the recording being analysed for breaks
    preparing: null,    // the recording being prepared for the Apple client
    // How many captures are running (recordingEngine sets this): capture outranks every job.
    capturing: () => 0
};
