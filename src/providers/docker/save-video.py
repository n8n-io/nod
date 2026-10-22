#!/opt/yt-dlp/bin/python3
import json
import os
import re
import subprocess
import sys

import yt_dlp


LIMIT = 50 * 1024 * 1024
BUDGET = int(LIMIT * 0.94)
SECTION = 'Download a section with --download-sections "*START-END", or keep it in the workspace with --full.'


class Failure(Exception):
    pass


class Quiet:
    def debug(self, message):
        pass

    info = warning = error = debug


class Collect(yt_dlp.postprocessor.PostProcessor):
    def __init__(self):
        super().__init__()
        self.infos = []

    def run(self, info):
        keys = ("filepath", "title", "uploader", "channel", "webpage_url")
        self.infos.append({key: info.get(key) for key in keys})
        return [], info


def reason(error):
    return re.sub(r"^ERROR:\s*", "", str(error)).split("; please report this issue")[0]


def short_side(kbps):
    for floor, side in ((2500, 1080), (1200, 720), (700, 480), (350, 360)):
        if kbps >= floor:
            return side
    return 240


def audio_rate(kbps):
    return 128 if kbps >= 700 else 96 if kbps >= 300 else 64


def probe(path):
    command = ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]
    data = json.loads(subprocess.run(command, capture_output=True, text=True, check=True).stdout)
    streams = data.get("streams", [])
    video = next(
        (
            s
            for s in streams
            if s["codec_type"] == "video" and not s.get("disposition", {}).get("attached_pic")
        ),
        None,
    )
    audio = next((s for s in streams if s["codec_type"] == "audio"), None)
    return video, audio, float(data.get("format", {}).get("duration") or 0)


def ffmpeg(source, target, codec):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", source, "-map", "0:V:0", "-map", "0:a:0?"]
        + codec
        + ["-movflags", "+faststart", target],
        check=True,
    )


def normalize(path, full):
    video, audio, duration = probe(path)
    if not video:
        raise Failure("The download has no video stream.")
    base = os.path.splitext(path)[0]
    target = base + ".mp4"
    temporary = base + ".nod.mp4"
    kbps = BUDGET * 8 / 1000 / max(duration, 1)
    smallest = min(video["width"], video["height"])
    compatible = (
        video["codec_name"] == "h264"
        and video.get("pix_fmt") in ("yuv420p", "yuvj420p")
        and (not audio or audio["codec_name"] == "aac")
    )
    note = None
    if full or (compatible and os.path.getsize(path) <= BUDGET):
        try:
            ffmpeg(path, temporary, ["-c", "copy"])
        except subprocess.CalledProcessError:
            if not full:
                raise
            if os.path.exists(temporary):
                os.remove(temporary)
            return path, video, duration, None
    else:
        for factor in (1, 0.8, 0.6):
            side = min(short_side(kbps * factor), smallest)
            rate = audio_rate(kbps * factor)
            maximum = max(int(kbps * factor) - (rate if audio else 0), 80)
            ffmpeg(
                path,
                temporary,
                [
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                    "-maxrate", f"{maximum}k", "-bufsize", f"{maximum * 2}k",
                    "-vf", f"scale='if(gte(iw,ih),-2,{side})':'if(gte(iw,ih),{side},-2)'",
                    "-fpsmax", "30" if kbps * factor < 1200 else "60",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", f"{rate}k", "-ac", "2",
                ],
            )
            if os.path.getsize(temporary) <= LIMIT:
                break
        else:
            os.remove(temporary)
            os.remove(path)
            raise Failure(f"The video does not fit the 50 MB limit for sending. {SECTION}")
        if side < smallest:
            note = f"compressed to {side}p to fit the 50 MB limit for sending"
    os.replace(temporary, target)
    if path != target:
        os.remove(path)
    final, _, seconds = probe(target)
    return target, final, seconds, note


def sorts(entries, duration):
    if not duration:
        return ["lang", "vcodec:h264", "res:1080", "acodec:aac"], ["lang", "res:1080"]
    kbps = BUDGET * 8 / 1000 / duration
    side = short_side(kbps)
    video = int(BUDGET - duration * audio_rate(kbps) * 125)
    formats = [
        f
        for entry in entries
        for f in entry.get("formats") or []
        if f.get("vcodec") not in (None, "none") and f.get("width") and f.get("height")
    ]
    h264 = [f for f in formats if re.match(r"avc|h264", f["vcodec"])] or formats
    good = min(720, side, max((min(f["width"], f["height"]) for f in h264), default=0))
    fits = any(
        min(f["width"], f["height"]) >= good
        and (f.get("filesize") or f.get("filesize_approx") or LIMIT * 10) <= video
        for f in h264
    )
    size = f"size:{video}" if fits else f"res:{side}"
    return ["lang", "vcodec:h264", size, "res:1080", "acodec:aac"], ["lang", f"res:{side}"]


def save(url, options, sections, full):
    collect = Collect()
    with yt_dlp.YoutubeDL(options) as ydl:
        ydl.add_post_processor(collect, when="after_move")
        info = ydl.extract_info(url, download=False)
        entries = [entry for entry in info.get("entries") or [info] if entry]
        if any(e.get("is_live") or e.get("live_status") == "is_upcoming" for e in entries):
            raise Failure("This is a live stream. Ask for a recording once it has ended.")
        duration = max((entry.get("duration") or 0 for entry in entries), default=0)
        if not full and not sections and duration > BUDGET * 8 / 1000 / 200:
            minutes = round(duration / 60)
            raise Failure(f"The video is {minutes} minutes long, too long for the 50 MB limit for sending. {SECTION}")
        if not full and not sections and not duration and any(e.get("live_status") == "was_live" for e in entries):
            raise Failure(f"This is a recorded live broadcast of unknown length. {SECTION}")
        chosen = not options.get("format") and not options.get("format_sort")
        if chosen:
            sort, fallback = sorts(entries, 0 if sections or full else duration)
            ydl.params["format_sort"] = sort
        try:
            ydl.process_ie_result(info, download=True)
        except yt_dlp.utils.DownloadError as error:
            if collect.infos:
                print(f"save-video: skipped part of the post: {reason(error)}", file=sys.stderr)
            elif not chosen:
                raise
            else:
                ydl.params["format_sort"] = fallback
                ydl.extract_info(url, download=True)
    results = []
    for entry in collect.infos:
        path, video, seconds, note = normalize(entry["filepath"], full)
        result = {
            "file": os.path.relpath(path),
            "title": entry["title"],
            "uploader": entry["uploader"] or entry["channel"],
            "duration": round(seconds),
            "resolution": f"{video['width']}x{video['height']}",
            "size": f"{os.path.getsize(path) / 1048576:.1f} MB",
            "source": entry["webpage_url"],
        }
        results.append({**result, "note": note} if note else result)
    if not results:
        raise Failure("No video was downloaded.")
    return results


def main():
    full = "--full" in sys.argv[1:]
    arguments = [argument for argument in sys.argv[1:] if argument != "--full"]
    if not arguments or arguments[0] in ("-h", "--help"):
        print(
            "usage: save-video [--full] URL [yt-dlp options]\n"
            "Saves the video as an H.264/AAC MP4 under 50 MB in the current folder "
            "and prints one JSON line per file. --full keeps the full length and "
            "quality in the workspace, without the 50 MB limit."
        )
        return 0
    parsed = yt_dlp.parse_options(arguments)
    if len(parsed.urls) != 1:
        print("save-video: pass exactly one URL.", file=sys.stderr)
        return 2
    ranges = parsed.ydl_opts.get("download_ranges")
    sections = bool(ranges and (ranges.chapters or ranges.ranges or ranges.from_info))
    options = {
        **parsed.ydl_opts,
        "logger": Quiet(),
        "quiet": True,
        "noprogress": True,
        "ignoreerrors": False,
        "overwrites": True,
        "noplaylist": True,
        "merge_output_format": "mp4",
        "concurrent_fragment_downloads": 4,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 20,
        "outtmpl": {"default": "%(title).60B [%(id)s].%(ext)s"},
    }
    try:
        results = save(parsed.urls[0], options, sections, full)
    except (yt_dlp.utils.DownloadError, Failure, subprocess.CalledProcessError) as error:
        print(f"save-video: {reason(error)}", file=sys.stderr)
        return 1
    for result in results:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
