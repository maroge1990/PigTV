// hold.swift <url> <seconds>: plays a live HLS URL with AVPlayer as PigTV's Apple app does, with one of four ways
// of holding back from the live edge at the start (#7), and scores it: time to the first picture, stalls, and the
// seconds the picture stood still after it first moved. Built from the 28 Oct harness (../2026-10-28-avsync-start-repro/
// avsync.swift) without its audio tap, which never runs on HLS.
//
// VARIANT=HOLD    configuredTimeOffsetFromLive 30 s, as the app does today (PlayerSeekWindow.liveOffset)
// VARIANT=NOHOLD  AVPlayer's own default offset (reference)
// VARIANT=RATE    default offset, played at RATE (0.97) with a pitch-preserving algorithm until TARGET (30) s
//                 behind the edge, then at 1.0: the buffer builds while the picture moves
// VARIANT=GROW    default offset; at the k-th stall the player waits until min(STEP*k, TARGET) s are buffered
//                 ahead (STEP 4) before it plays again: the hold grows only when the feed proves bursty
import AVFoundation
import Foundation

setvbuf(stdout, nil, _IOLBF, 0) // a log file shows each line as it happens, not at exit

let args = CommandLine.arguments
let url = URL(string: args[1])!
let runFor = Double(args.count > 2 ? args[2] : "600")!
let env = ProcessInfo.processInfo.environment
let variant = env["VARIANT"] ?? "HOLD"
let target = Double(env["TARGET"] ?? "30")!
let slowRate = Float(env["RATE"] ?? "0.97")!
let step = Double(env["STEP"] ?? "4")!

let item = AVPlayerItem(url: url)
if variant == "HOLD" { item.configuredTimeOffsetFromLive = CMTime(seconds: target, preferredTimescale: 1) }
if variant == "RATE" { item.audioTimePitchAlgorithm = .timeDomain }
let player = AVPlayer(playerItem: item)
if variant == "RATE" { player.defaultRate = slowRate }
let t0 = Date()
func now() -> Double { Date().timeIntervalSince(t0) }
func stamp() -> String { String(format: "%7.2f", now()) }
print("variant \(variant) target \(target) rate \(slowRate) step \(step) run \(runFor) s")

var firstPicture: Double? = nil      // the first .playing
var frozenSince: Double? = nil       // not .playing since, once the picture has moved
var frozen = 0.0
var stalls = 0
var longest = 0.0
var growWaitFor: Double? = nil       // GROW: seconds of buffer to wait for before playing again
var reachedTarget = false

func buffered() -> Double {
    let t = CMTimeGetSeconds(player.currentTime())
    for r in item.loadedTimeRanges.map({ $0.timeRangeValue }) {
        let s = CMTimeGetSeconds(r.start), e = CMTimeGetSeconds(CMTimeRangeGetEnd(r))
        if t >= s - 0.5 && t <= e { return e - t }
    }
    return 0
}
func behindEdge() -> Double {
    guard let r = item.seekableTimeRanges.last?.timeRangeValue else { return .nan }
    return CMTimeGetSeconds(CMTimeRangeGetEnd(r)) - CMTimeGetSeconds(player.currentTime())
}

NotificationCenter.default.addObserver(forName: AVPlayerItem.playbackStalledNotification, object: item, queue: .main) { _ in
    stalls += 1
    print("\(stamp()) EVENT stalled #\(stalls) behindEdge=\(String(format: "%.2f", behindEdge()))")
    if variant == "GROW" {
        growWaitFor = min(step * Double(stalls), target)
        player.pause()
        print("\(stamp()) EVENT grow: waiting for \(growWaitFor!) s of buffer")
    }
}
NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) { n in
    print("\(stamp()) EVENT failed \(String(describing: n.userInfo))")
}
let statusObs = player.observe(\.timeControlStatus, options: [.new]) { p, _ in
    let s = ["paused", "waiting", "playing"][p.timeControlStatus.rawValue]
    print("\(stamp()) EVENT \(s) \(p.reasonForWaitingToPlay?.rawValue ?? "")")
    if p.timeControlStatus == .playing {
        if firstPicture == nil { firstPicture = now() }
        if let since = frozenSince { let d = now() - since; frozen += d; longest = max(longest, d); frozenSince = nil }
    } else if firstPicture != nil, frozenSince == nil {
        frozenSince = now()
    }
}
player.play()

var lastPrint = -10.0
while now() < runFor {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    if variant == "GROW", let need = growWaitFor, buffered() >= need {
        growWaitFor = nil
        print("\(stamp()) EVENT grow: \(String(format: "%.1f", buffered())) s buffered, playing")
        player.play()
    }
    if variant == "RATE", !reachedTarget, firstPicture != nil, behindEdge() >= target {
        reachedTarget = true
        player.defaultRate = 1
        if player.timeControlStatus == .playing { player.rate = 1 }
        print("\(stamp()) EVENT rate: \(target) s behind the edge, now 1.0")
    }
    if now() - lastPrint >= 10 {
        lastPrint = now()
        print(String(format: "%@ rate=%.2f behindEdge=%6.2f buffered=%6.2f stalls=%d frozen=%.1f",
                     stamp(), player.rate, behindEdge(), buffered(), stalls, frozen))
    }
}
if let since = frozenSince { let d = now() - since; frozen += d; longest = max(longest, d) }
let start = firstPicture ?? runFor
print(String(format: "SCORE variant=%@ start=%.2f stalls=%d frozen=%.1f longest=%.1f stallsXfrozen=%.1f behindEdge=%.1f",
             variant, start, stalls, frozen, longest, Double(stalls) * frozen, behindEdge()))
_ = statusObs
