"""Bounded PigTV audit measurements. Credentials stay out of saved results.

Set PIGTV_AUDIT_TOKEN to a signed-in token. --live opens two sequential
channel sessions and releases each in finally; it never forces takeover.
"""
import argparse, json, os, statistics, time, urllib.request, urllib.error

p = argparse.ArgumentParser()
p.add_argument('--origin', default='http://192.168.1.235:3000')
p.add_argument('--live', action='store_true')
p.add_argument('--output', required=True)
a = p.parse_args()
token = os.environ['PIGTV_AUDIT_TOKEN']
results = {'origin': a.origin, 'samples': [], 'live': []}

def call(path, method='GET', data=None):
    request = urllib.request.Request(a.origin + path, method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            body = response.read()
            return response.status, body, round((time.perf_counter()-started)*1000, 2)
    except urllib.error.HTTPError as error:
        return error.code, error.read(), round((time.perf_counter()-started)*1000, 2)

for path, count in [('/api/sports/events?hours=72', 8), ('/api/library/guide?limit=500', 3), ('/api/version', 5)]:
    for n in range(count):
        code, body, ms = call(path)
        row = {'path': path, 'sample': n+1, 'status': code, 'ms': ms, 'bytes': len(body)}
        results['samples'].append(row)
        print(json.dumps(row), flush=True)

if a.live:
    for channel in ['pos_26', 'pos_118']:
        sid = None
        row = {'channelId': channel}
        try:
            code, body, ms = call('/api/playback/resolve', 'POST', {
                'sourceId': 8, 'channelId': channel,
                'capabilities': {'hls': True, 'segmentedDelivery': True, 'fmp4': True,
                    'hevc': True, 'av1': False, 'ac3': True, 'eac3': True, 'flac': False, 'heaac': True}})
            row.update(status=code, resolveMs=ms)
            if code == 200:
                decision = json.loads(body)
                sid = decision.get('sessionId')
                row.update(strategy=decision.get('strategy'), container=decision.get('container'), info=decision.get('info'))
                if sid:
                    code, body, ms = call('/api/transcode/' + sid + '/stream.m3u8')
                    row.update(playlistStatus=code, playlistMs=ms)
                    if code == 200:
                        lines = body.decode().splitlines()
                        segments = [s for s in lines if s and not s.startswith('#')]
                        row['segmentsAvailable'] = len(segments)
                        if segments:
                            # Only follow server-local session segments, never arbitrary URLs.
                            name = segments[-1].split('?')[0]
                            if '/' not in name and '..' not in name:
                                code, body, ms = call('/api/transcode/' + sid + '/' + name)
                                row.update(segmentStatus=code, segmentMs=ms, segmentBytes=len(body))
        finally:
            if sid:
                code, _, ms = call('/api/playback/' + sid, 'DELETE')
                row.update(releaseStatus=code, releaseMs=ms)
            results['live'].append(row)
            print(json.dumps(row), flush=True)
            with open(a.output, 'w') as f: json.dump(results, f, indent=2)

with open(a.output, 'w') as f: json.dump(results, f, indent=2)
