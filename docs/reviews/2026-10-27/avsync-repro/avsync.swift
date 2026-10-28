// avsync.swift <url> <seconds>: plays an HLS URL with AVPlayer the way PigTV's Apple app does
// (configuredTimeOffsetFromLive 30 s) and reports, against the item's own timebase, which audio is
// being rendered (an MTAudioProcessingTap) and which video frame is current (AVPlayerItemVideoOutput).
// audioLead = tap audio time - timebase time; videoLead = current frame time - timebase time.
// In sync, both stay near a small constant; sound behind the picture shows as audioLead - videoLead < 0.
import AVFoundation
import MediaToolbox
import Foundation

let args = CommandLine.arguments
let url = URL(string: args[1])!
let runFor = Double(args.count > 2 ? args[2] : "60")!

nonisolated(unsafe) var sharedTimebase: CMTimebase?
nonisolated(unsafe) var lastAudioLead: Double = .nan
nonisolated(unsafe) var tapCalls = 0
let lock = NSLock()

let tapProcess: MTAudioProcessingTapProcessCallback = { tap, frames, _, bufferList, framesOut, flagsOut in
    var range = CMTimeRange()
    let status = MTAudioProcessingTapGetSourceAudio(tap, frames, bufferList, flagsOut, &range, framesOut)
    guard status == noErr, let tb = sharedTimebase else { return }
    let now = CMTimeGetSeconds(CMTimebaseGetTime(tb))
    let audio = CMTimeGetSeconds(range.start)
    if audio.isFinite && now.isFinite {
        lock.lock(); lastAudioLead = audio - now; tapCalls += 1; lock.unlock()
    }
    // silence the output: the measurement needs the timing, not the tone
    let abl = UnsafeMutableAudioBufferListPointer(bufferList)
    for b in abl { if let d = b.mData { memset(d, 0, Int(b.mDataByteSize)) } }
}

func makeTap() -> MTAudioProcessingTap? {
    var callbacks = MTAudioProcessingTapCallbacks(
        version: kMTAudioProcessingTapCallbacksVersion_0, clientInfo: nil,
        init: { _, _, storageOut in storageOut.pointee = nil }, finalize: nil,
        prepare: nil, unprepare: nil, process: tapProcess)
    var tap: MTAudioProcessingTap?
    let err = MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PreEffects, &tap)
    return err == noErr ? tap : nil
}

let item = AVPlayerItem(url: url)
item.configuredTimeOffsetFromLive = CMTime(seconds: 30, preferredTimescale: 1) // PlayerSeekWindow.liveOffset
let videoOut = AVPlayerItemVideoOutput(pixelBufferAttributes: nil)
item.add(videoOut)
let player = AVPlayer(playerItem: item)
let t0 = Date()
func stamp() -> String { String(format: "%6.2f", Date().timeIntervalSince(t0)) }

var stalls = 0
NotificationCenter.default.addObserver(forName: AVPlayerItem.playbackStalledNotification, object: item, queue: .main) { _ in
    stalls += 1; print("\(stamp()) EVENT playbackStalled (#\(stalls))")
}
NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) { n in
    print("\(stamp()) EVENT failed \(String(describing: n.userInfo))")
}
let statusObs = player.observe(\.timeControlStatus, options: [.new]) { p, _ in
    let s = ["paused", "waiting", "playing"][p.timeControlStatus.rawValue]
    print("\(stamp()) EVENT timeControlStatus=\(s) \(p.reasonForWaitingToPlay?.rawValue ?? "")")
}
var tapInstalled = false
let readyObs = item.observe(\.status, options: [.new]) { it, _ in
    print("\(stamp()) EVENT item.status=\(it.status.rawValue) \(it.error?.localizedDescription ?? "")")
}
player.play()

var lastPrint = -1.0
var lastVideoLead = Double.nan
while Date().timeIntervalSince(t0) < runFor {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    sharedTimebase = item.timebase
    if !tapInstalled, item.status == .readyToPlay, let track = item.tracks.compactMap({ $0.assetTrack }).first(where: { $0.mediaType == .audio }) {
        let params = AVMutableAudioMixInputParameters(track: track)
        params.audioTapProcessor = makeTap()
        let mix = AVMutableAudioMix(); mix.inputParameters = [params]
        item.audioMix = mix
        tapInstalled = true
        print("\(stamp()) EVENT audio tap installed")
    }
    let host = CACurrentMediaTime()
    let itemTime = videoOut.itemTime(forHostTime: host)
    var shown = CMTime.invalid
    if videoOut.hasNewPixelBuffer(forItemTime: itemTime), videoOut.copyPixelBuffer(forItemTime: itemTime, itemTimeForDisplay: &shown) != nil, shown.isValid,
       let tbNow = item.timebase.map({ CMTimeGetSeconds(CMTimebaseGetTime($0)) }) { lastVideoLead = CMTimeGetSeconds(shown) - tbNow }
    let elapsed = Date().timeIntervalSince(t0)
    if elapsed - lastPrint >= 1.0 {
        lastPrint = elapsed
        let tb = item.timebase.map { CMTimeGetSeconds(CMTimebaseGetTime($0)) } ?? .nan
        let rate = item.timebase.map { CMTimebaseGetRate($0) } ?? .nan
        lock.lock(); let aLead = lastAudioLead; let calls = tapCalls; lock.unlock()
        let vLead = lastVideoLead
        let edge = item.seekableTimeRanges.last.map { CMTimeGetSeconds(CMTimeRangeGetEnd($0.timeRangeValue)) } ?? .nan
        print(String(format: "%@ t=%7.3f rate=%.2f edge=%7.3f behindEdge=%6.2f audioLead=%7.3f videoLead=%7.3f  sound-minus-picture=%7.3f tapCalls=%d stalls=%d",
                     stamp(), tb, rate, edge, edge - tb, aLead, vLead, aLead - vLead, calls, stalls))
    }
}
_ = statusObs; _ = readyObs
