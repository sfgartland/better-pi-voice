#!/usr/bin/env python3
"""Generate media/demo.mp4 — a before/after storyboard for better-pi-voice.

Renders a typing animation of the same sentence through the "without keyterms" and
"with keyterms" panels, then encodes the frames with ffmpeg. Deterministic and
reproducible: no screen recording, just the storyboard the README shows as text.

Usage: python3 scripts/make-demo-video.py [output.mp4]
Requires: rsvg-convert, ffmpeg (libx264).
"""
import math
import os
import shutil
import subprocess
import sys
import tempfile

W, H, FPS, DUR = 1280, 640, 20, 8.0
NORMAL, RED, GREEN = "#c9d1d9", "#f85149", "#3fb950"
MONO_ADVANCE = 0.602  # DejaVu Sans Mono advance width, in em

# (text, colour) segments, so a line can be revealed character by character while
# keeping the wrong/right words coloured.
WITHOUT = [
    [("… so the ", NORMAL), ("sub agent", RED), (" can use the ", NORMAL), ("Worktree", RED)],
    [("T's config", RED), (", then check the ", NORMAL), ("Marginalia", RED), (" OAuth webhook.", NORMAL)],
]
WITH = [
    [("… so the ", NORMAL), ("subagent", GREEN), (" can use the ", NORMAL), ("worktree", GREEN)],
    [("tsconfig", GREEN), (", then check the ", NORMAL), ("marginalia", GREEN), (" OAuth webhook.", NORMAL)],
]


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def fade(t, start, dur):
    return clamp((t - start) / dur) if dur > 0 else (1.0 if t >= start else 0.0)


def typed(segments, t, start, dur):
    """Reveal `segments` character by character between start and start+dur."""
    full = "".join(text for text, _ in segments)
    count = math.floor(len(full) * clamp((t - start) / dur)) if dur > 0 else len(full)
    out, remaining = [], count
    for text, colour in segments:
        if remaining <= 0:
            break
        take = text[:remaining]
        remaining -= len(take)
        if take:
            out.append((take, colour))
    return "".join(f'<tspan fill="{c}">{esc(txt)}</tspan>' for txt, c in out), count, len(full)


def line(x, y, size, spans):
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{NORMAL}" xml:space="preserve">{spans}</text>'


def cursor(x, y, size, visible):
    if not visible:
        return ""
    cw = size * MONO_ADVANCE
    return f'<rect x="{x:.0f}" y="{y - size + 4}" width="{cw:.0f}" height="{size}" fill="#e6edf3" opacity="0.7"/>'


def frame_svg(t):
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="DejaVu Sans Mono, monospace">']
    s.append('<rect width="1280" height="640" fill="#0b0e14"/>')
    s.append('<rect x="0.5" y="0.5" width="1279" height="639" fill="none" stroke="#1f242d"/>')

    title = fade(t, 0.0, 0.5)
    sub = fade(t, 0.15, 0.5)
    s.append(f'<g opacity="{title:.2f}"><text x="64" y="86" font-size="44" font-weight="bold" fill="#e6edf3">better-pi-voice</text></g>')
    s.append(f'<g opacity="{sub:.2f}"><text x="64" y="124" font-size="20" fill="#8b949e">Streaming voice input for pi — biased with your repository&#8217;s vocabulary</text></g>')
    s.append('<rect x="1012" y="66" width="204" height="40" rx="20" fill="#161b22" stroke="#30363d"/>')
    s.append('<text x="1114" y="92" font-size="16" fill="#c9d1d9" text-anchor="middle">hold ctrl+alt+z</text>')

    # panel 1 — without keyterms
    p1 = fade(t, 0.6, 0.3)
    s.append(f'<g opacity="{p1:.2f}">')
    s.append('<rect x="64" y="168" width="1152" height="150" rx="12" fill="#11151c" stroke="#2a1f1a"/>')
    s.append('<text x="92" y="202" font-size="16" fill="#f0883e" letter-spacing="2">WITHOUT KEYTERMS</text>')
    l1, c1, f1 = typed(WITHOUT[0], t, 0.9, 1.1)
    l2, c2, f2 = typed(WITHOUT[1], t, 2.0, 1.0)
    s.append(line(92, 244, 23, l1) + cursor(92 + c1 * 23 * MONO_ADVANCE, 244, 23, 0 < c1 < f1))
    s.append(line(92, 278, 23, l2) + cursor(92 + c2 * 23 * MONO_ADVANCE, 278, 23, c1 >= f1 and 0 < c2 < f2))
    s.append(f'<g opacity="{fade(t, 3.1, 0.3):.2f}"><text x="1188" y="202" font-size="16" fill="#f85149" text-anchor="end">✗ misheard</text></g>')
    s.append("</g>")

    # panel 2 — with keyterms
    p2 = fade(t, 3.6, 0.3)
    s.append(f'<g opacity="{p2:.2f}">')
    s.append('<rect x="64" y="340" width="1152" height="150" rx="12" fill="#0f1712" stroke="#1f3a26"/>')
    s.append('<text x="92" y="374" font-size="16" fill="#3fb950" letter-spacing="2">WITH KEYTERMS</text>')
    l3, c3, f3 = typed(WITH[0], t, 3.9, 1.1)
    l4, c4, f4 = typed(WITH[1], t, 5.0, 1.0)
    s.append(line(92, 416, 23, l3) + cursor(92 + c3 * 23 * MONO_ADVANCE, 416, 23, 0 < c3 < f3))
    s.append(line(92, 450, 23, l4) + cursor(92 + c4 * 23 * MONO_ADVANCE, 450, 23, c3 >= f3 and 0 < c4 < f4))
    s.append(f'<g opacity="{fade(t, 6.1, 0.3):.2f}"><text x="1188" y="374" font-size="16" fill="#3fb950" text-anchor="end">✓ correct</text></g>')
    s.append("</g>")

    # footer
    f = fade(t, 6.6, 0.5)
    s.append(f'<g opacity="{f:.2f}">')
    s.append('<rect x="64" y="540" width="470" height="48" rx="10" fill="#161b22" stroke="#30363d"/>')
    s.append('<text x="88" y="571" font-size="19" fill="#7ee787">$</text>')
    s.append('<text x="104" y="571" font-size="19" fill="#c9d1d9">pi install npm:@sfgartland/better-pi-voice</text>')
    s.append('<text x="1216" y="560" font-size="16" fill="#8b949e" text-anchor="end">Deepgram nova-3 &#183; local Parakeet</text>')
    s.append('<text x="1216" y="586" font-size="16" fill="#8b949e" text-anchor="end">Claude-Code-style recovery &#183; MIT</text>')
    s.append("</g>")

    s.append("</svg>")
    return "".join(s)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "media/demo.mp4"
    if not shutil.which("rsvg-convert") or not shutil.which("ffmpeg"):
        sys.exit("need rsvg-convert and ffmpeg on PATH")
    frames = tempfile.mkdtemp(prefix="bpv-demo-")
    total = int(DUR * FPS)
    svg_path = os.path.join(frames, "frame.svg")
    for i in range(total):
        t = i / FPS
        with open(svg_path, "w") as fh:
            fh.write(frame_svg(t))
        subprocess.run(
            ["rsvg-convert", "-w", str(W), "-h", str(H), svg_path, "-o", os.path.join(frames, f"f{i:04d}.png")],
            check=True,
        )
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", os.path.join(frames, "f%04d.png"),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-movflags", "+faststart", out],
        check=True,
    )
    shutil.rmtree(frames, ignore_errors=True)
    print(f"wrote {out} ({total} frames, {DUR}s)")


if __name__ == "__main__":
    main()
