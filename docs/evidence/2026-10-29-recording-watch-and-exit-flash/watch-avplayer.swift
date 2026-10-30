import Foundation
import AVFoundation
let player = AVPlayer(url: URL(string: "http://127.0.0.1:18763/view.m3u8")!)
player.play()
let deadline = Date().addingTimeInterval(20)
var success = false
while Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    if player.currentItem?.status == .failed {
        print("FAILED", player.currentItem?.error?.localizedDescription ?? "unknown")
        break
    }
    if player.timeControlStatus == .playing && player.currentTime().seconds > 2 {
        print("PASS: raw recording #203 repaired watch copy is playing in macOS AVPlayer; clock", player.currentTime().seconds)
        success = true
        break
    }
}
player.pause()
player.replaceCurrentItem(with: nil)
if !success { print("FAIL: no advancing playback within 20 s"); exit(1) }
