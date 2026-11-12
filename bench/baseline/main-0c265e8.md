# graphraum browser benchmark

Absolute numbers are machine-specific. Compare two runs only when they come from the same machine, browser and GL renderer, and compare the medians together with the spread (p95, min, max).

| Field | Value |
| --- | --- |
| Generated | 2026-11-12T22:15:38.521Z |
| Commit | 0c265e8  |
| Browser | Chromium 156.0.8078.4 (Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.8078.4 Safari/537.36) |
| GL renderer | ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version) (Google Inc. (Apple)) |
| Software rasterizer | no |
| Chromium switches | --use-angle=metal --ignore-gpu-blocklist |
| GPU timer (EXT_disjoint_timer_query_webgl2) | available |
| Device pixel ratio / max pixel ratio | 1 / 1 |
| Viewport | 800 x 600 CSS px |
| Protocol | 3 fresh-page runs per case in randomized order (seed 1372659545); cold = one value per run, warm = every frame sample from every run pooled |

## Per-frame cost under 2D pan/zoom and 3D camera moves

| Case | Mode | Nodes / edges | camera step ms (median) | camera step ms (p95) | render CPU ms (median) | render CPU ms (p95) | GPU ms (median) | frame interval ms (p95) | n |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pan and zoom 10,000 | 2D | 10,000 / 30,000 | 26.3 | 48.4 | 0.10 | 0.20 | 2.60 | 48.8 | 360 |
| Pan and zoom 100,000 | 2D | 100,000 / 300,000 | 211 | 293 | 0.30 | 1.20 | 8.53 | 294 | 180 |
| Orbit camera 10,000 | 3D | 10,000 / 30,000 | 16.6 | 20.2 | 0.10 | 0.30 | 2.24 | 20.6 | 360 |
| Orbit camera 100,000 | 3D | 100,000 / 300,000 | 103 | 119 | 0.70 | 1.00 | 5.13 | 120 | 180 |

Cold costs (first pass of each fresh page, median of runs, min to max):

| Case | construct ms | setData ms | first frame ms | first frame CPU ms |
| --- | --- | --- | --- | --- |
| Pan and zoom 10,000 | 8.90 (7.40 to 9.00) | 109 (93.9 to 111) | 67.5 (62.8 to 69.1) | 35.9 (33.4 to 37.5) |
| Pan and zoom 100,000 | 8.60 (8.40 to 8.60) | 722 (706 to 782) | 261 (259 to 268) | 94.6 (91.3 to 96.9) |
| Orbit camera 10,000 | 8.20 (7.40 to 8.70) | 91.2 (86.9 to 93.3) | 58.6 (53.8 to 58.8) | 33.2 (30.8 to 34.1) |
| Orbit camera 100,000 | 9.80 (9.00 to 10.9) | 770 (708 to 784) | 246 (199 to 264) | 114 (85.7 to 133) |

- Pan and zoom 10,000: 20 warm-up frames, then 120 frames; each frame moves the camera with setCameraState() and renders once, so the step column includes viewport materialization.
- Pan and zoom 100,000: 20 warm-up frames, then 60 frames; each frame moves the camera with setCameraState() and renders once, so the step column includes viewport materialization.
- Orbit camera 10,000: 20 warm-up frames, then 120 frames; each frame moves the camera with setCameraState() and renders once, so the step column includes viewport materialization.
- Orbit camera 100,000: 20 warm-up frames, then 60 frames; each frame moves the camera with setCameraState() and renders once, so the step column includes viewport materialization.

## Selection and edge hover (setSelection, setEdgeSelection)

| Case | Mode | Nodes / edges | call ms (median) | call ms (p95) | render CPU ms (median) | render CPU ms (p95) | GPU ms (median) | call to next frame ms (p95) | n |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| setSelection 10,000 | 2D | 10,000 / 30,000 | 0.00 | 0.10 | 0.10 | 0.20 | 2.71 | 17.9 | 360 |
| setSelection 100,000 | 2D | 100,000 / 300,000 | 0.10 | 0.20 | 0.10 | 0.20 | 2.93 | 17.9 | 180 |
| setEdgeSelection hover 2,000 | 2D | 2,000 / 6,000 | 0.00 | 0.10 | 0.10 | 0.20 | 1.18 | 18.4 | 360 |
| setEdgeSelection hover 10,000 | 2D | 10,000 / 30,000 | 0.00 | 0.10 | 0.10 | 0.20 | 2.75 | 17.7 | 360 |

Cold costs (first pass of each fresh page, median of runs, min to max):

| Case | construct ms | setData ms | first frame ms | first frame CPU ms |
| --- | --- | --- | --- | --- |
| setSelection 10,000 | 8.10 (7.60 to 9.00) | 102 (92.7 to 114) | 62.9 (58.1 to 68.8) | 33.0 (30.0 to 37.1) |
| setSelection 100,000 | 8.80 (8.50 to 9.50) | 802 (799 to 863) | 270 (266 to 290) | 91.7 (89.6 to 94.3) |
| setEdgeSelection hover 2,000 | 7.10 (7.00 to 7.50) | 28.5 (26.7 to 28.6) | 25.2 (24.8 to 26.0) | 16.0 (15.5 to 16.8) |
| setEdgeSelection hover 10,000 | 8.80 (8.30 to 9.30) | 105 (105 to 106) | 67.9 (67.2 to 70.9) | 36.2 (35.0 to 38.5) |

- setSelection 10,000: 20 warm-up frames, then 120 frames; each frame selects a different node with setSelection().
- setSelection 100,000: 20 warm-up frames, then 60 frames; each frame selects a different node with setSelection().
- setEdgeSelection hover 2,000: 20 warm-up frames, then 120 frames; each frame highlights a different edge with setEdgeSelection(), as a hover would.
- setEdgeSelection hover 10,000: 20 warm-up frames, then 120 frames; each frame highlights a different edge with setEdgeSelection(), as a hover would.

## Worker force layout (#147)

| Case | Mode | Nodes / edges | startup ms | transfer ms | compute ms | first useful frame ms | total ms | total ms (max) | n |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Worker force layout 10,000 | 3D | 10,000 / 30,000 | 0.10 | 1.90 | 20.1 | 53.0 | 169 | 173 | 3 |
| Worker force layout 100,000 | 3D | 100,000 / 300,000 | 0.10 | 19.7 | 134 | 213 | 560 | 568 | 3 |

- Worker force layout 10,000: One force layout in the docs layout worker, streamed back in batches and applied to a mounted graph. Startup is Worker construction on the main thread, transfer is packing and posting the edge buffer, compute is the worker's own solve time, first useful frame is start to the first applied batch, total is start to the last batch.
- Worker force layout 100,000: One force layout in the docs layout worker, streamed back in batches and applied to a mounted graph. Startup is Worker construction on the main thread, transfer is packing and posting the edge buffer, compute is the worker's own solve time, first useful frame is start to the first applied batch, total is start to the last batch.

## Glow halos (14 and 256 glow nodes)

| Case | Mode | Nodes / edges | camera step ms (median) | camera step ms (p95) | render CPU ms (median) | render CPU ms (p95) | GPU ms (median) | frame interval ms (p95) | n |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Glow 14 light 2D | 2D | 2,000 / 6,000 | 4.90 | 8.60 | 0.10 | 0.20 | 1.14 | 18.4 | 360 |
| Glow 14 light 3D | 3D | 2,000 / 6,000 | 3.30 | 4.20 | 0.10 | 0.20 | 0.91 | 17.9 | 360 |
| Glow 14 dark 2D | 2D | 2,000 / 6,000 | 5.20 | 9.50 | 0.10 | 0.20 | 1.00 | 18.0 | 360 |
| Glow 14 dark 3D | 3D | 2,000 / 6,000 | 3.30 | 4.00 | 0.10 | 0.20 | 1.00 | 17.6 | 360 |
| Glow 256 light 2D | 2D | 2,000 / 6,000 | 5.10 | 10.3 | 0.10 | 0.20 | 1.11 | 17.9 | 360 |
| Glow 256 light 3D | 3D | 2,000 / 6,000 | 3.40 | 3.80 | 0.10 | 0.20 | 0.92 | 18.0 | 360 |
| Glow 256 dark 2D | 2D | 2,000 / 6,000 | 5.00 | 9.00 | 0.10 | 0.20 | 1.12 | 17.8 | 360 |
| Glow 256 dark 3D | 3D | 2,000 / 6,000 | 3.50 | 4.10 | 0.10 | 0.20 | 0.96 | 17.8 | 360 |

Cold costs (first pass of each fresh page, median of runs, min to max):

| Case | construct ms | setData ms | first frame ms | first frame CPU ms |
| --- | --- | --- | --- | --- |
| Glow 14 light 2D | 7.90 (7.60 to 9.00) | 29.2 (29.1 to 33.2) | 27.2 (26.3 to 34.6) | 18.0 (16.9 to 23.9) |
| Glow 14 light 3D | 8.00 (7.10 to 8.30) | 28.7 (25.6 to 28.8) | 28.2 (24.4 to 29.2) | 19.4 (16.6 to 19.9) |
| Glow 14 dark 2D | 8.20 (7.70 to 8.70) | 32.0 (30.0 to 32.0) | 31.0 (26.8 to 31.2) | 19.8 (17.2 to 20.0) |
| Glow 14 dark 3D | 8.40 (7.90 to 8.90) | 27.6 (27.6 to 30.4) | 28.6 (28.3 to 102) | 19.9 (19.4 to 93.6) |
| Glow 256 light 2D | 8.20 (7.90 to 8.40) | 31.6 (28.9 to 32.9) | 31.2 (29.5 to 32.1) | 19.9 (19.3 to 20.5) |
| Glow 256 light 3D | 8.30 (5.10 to 9.50) | 28.3 (24.3 to 30.7) | 28.7 (19.0 to 29.5) | 19.5 (13.8 to 19.9) |
| Glow 256 dark 2D | 8.50 (7.60 to 8.70) | 31.8 (28.1 to 32.2) | 28.7 (26.0 to 31.2) | 18.6 (16.8 to 20.2) |
| Glow 256 dark 3D | 7.90 (7.50 to 7.90) | 27.7 (25.9 to 28.3) | 27.4 (24.6 to 27.8) | 18.7 (16.5 to 18.8) |

- Glow 14 light 2D: 14 nodes with glow 1, light theme; 20 warm-up frames, then 120 camera-move frames (2D pan/zoom, 3D orbit).
- Glow 14 light 3D: 14 nodes with glow 1, light theme; 20 warm-up frames, then 120 camera-move frames (2D pan/zoom, 3D orbit).
- Glow 14 dark 2D: 14 nodes with glow 1, dark theme; 20 warm-up frames, then 120 camera-move frames (2D pan/zoom, 3D orbit).
- Glow 14 dark 3D: 14 nodes with glow 1, dark theme; 20 warm-up frames, then 120 camera-move frames (2D pan/zoom, 3D orbit).
- Glow 256 light 2D: 256 nodes with glow 1, light theme; 20 warm-up frames, then 120 camera-move frames (2D pan/zoom, 3D orbit).
- Glow 256 light 3D: 256 nodes with glow 1, light theme; 20 warm-up frames, then 120 camera-move frames (2D pan/zoom, 3D orbit).
- Glow 256 dark 2D: 256 nodes with glow 1, dark theme; 20 warm-up frames, then 120 camera-move frames (2D pan/zoom, 3D orbit).
- Glow 256 dark 3D: 256 nodes with glow 1, dark theme; 20 warm-up frames, then 120 camera-move frames (2D pan/zoom, 3D orbit).

## 3D auto-orbit

| Case | Mode | Nodes / edges | render CPU ms (median) | render CPU ms (p95) | GPU ms (median) | frame interval ms (p95) | n |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Auto-orbit 2,000 | 3D | 2,000 / 6,000 | 0.10 | 0.20 | 0.90 | 16.7 | 360 |
| Auto-orbit 10,000 | 3D | 10,000 / 30,000 | 0.10 | 0.20 | 1.60 | 16.8 | 360 |

Cold costs (first pass of each fresh page, median of runs, min to max):

| Case | construct ms | setData ms | first frame ms | first frame CPU ms |
| --- | --- | --- | --- | --- |
| Auto-orbit 2,000 | 8.00 (7.90 to 8.60) | 28.1 (28.0 to 28.1) | 28.1 (27.8 to 28.4) | 18.6 (18.4 to 18.9) |
| Auto-orbit 10,000 | 7.80 (7.30 to 9.00) | 93.1 (89.2 to 98.8) | 55.1 (53.9 to 59.8) | 31.9 (30.4 to 35.4) |

- Auto-orbit 2,000: setAutoOrbit({ speed: 0.5 }); 20 warm-up frames, then 120 frames driven by the orbit loop itself (no per-frame calls from the benchmark).
- Auto-orbit 10,000: setAutoOrbit({ speed: 0.5 }); 20 warm-up frames, then 120 frames driven by the orbit loop itself (no per-frame calls from the benchmark).

## Scaling ladder

Edges are 3x nodes. Median and p95 in ms per size; the exponent is the slope of a log-log fit of the medians (about 1 is linear). Charts: the HTML report next to this file.

### 2D pan, main-thread ms per frame

| Nodes | median ms | p95 ms | n | note |
| --- | --- | --- | --- | --- |
| 1,000 | 1.60 | 2.30 | 360 |  |
| 3,000 | 3.20 | 4.30 | 360 |  |
| 10,000 | 9.00 | 10.5 | 360 |  |
| 30,000 | 28.0 | 32.3 | 360 |  |
| 100,000 | 92.4 | 113 | 180 |  |
| 300,000 | 216 | 242 | 180 |  |

Scaling exponent ~0.89 (linear). Crosses 16.7 ms at about 18,192 nodes.

### 2D zoom, main-thread ms per frame

| Nodes | median ms | p95 ms | n | note |
| --- | --- | --- | --- | --- |
| 1,000 | 2.10 | 3.30 | 360 |  |
| 3,000 | 5.10 | 7.20 | 360 |  |
| 10,000 | 16.0 | 22.5 | 360 |  |
| 30,000 | 54.2 | 78.0 | 360 |  |
| 100,000 | 110 | 139 | 180 |  |
| 300,000 | 160 | 212 | 180 |  |

Scaling exponent ~0.80 (sub-linear). Crosses 16.7 ms at about 10,393 nodes.

### 3D orbit, main-thread ms per frame

| Nodes | median ms | p95 ms | n | note |
| --- | --- | --- | --- | --- |
| 1,000 | 0.10 | 0.20 | 360 |  |
| 3,000 | 0.10 | 0.20 | 360 |  |
| 10,000 | 0.10 | 0.20 | 360 |  |
| 30,000 | 0.10 | 0.20 | 360 |  |
| 100,000 | 0.10 | 0.20 | 180 |  |
| 300,000 | 0.10 | 0.20 | 180 |  |

Scaling exponent ~0.00 (flat). Stays under 16.7 ms across the measured range.

### 3D orbit, GPU ms per frame

| Nodes | median ms | p95 ms | n | note |
| --- | --- | --- | --- | --- |
| 1,000 | 0.56 | 0.99 | 360 |  |
| 3,000 | 1.51 | 2.67 | 360 |  |
| 10,000 | 2.35 | 4.28 | 360 |  |
| 30,000 | 2.40 | 4.63 | 360 |  |
| 100,000 | 2.13 | 4.44 | 180 |  |
| 300,000 | 2.25 | 3.70 | 180 |  |

Scaling exponent ~0.20 (sub-linear). Stays under 16.7 ms across the measured range.

### Selection change, main-thread ms

| Nodes | median ms | p95 ms | n | note |
| --- | --- | --- | --- | --- |
| 1,000 | 0.10 | 0.30 | 360 |  |
| 3,000 | 0.10 | 0.30 | 360 |  |
| 10,000 | 0.10 | 0.30 | 360 |  |
| 30,000 | 0.10 | 0.30 | 360 |  |
| 100,000 | 0.20 | 0.30 | 180 |  |
| 300,000 | 0.10 | 0.30 | 180 |  |

Scaling exponent ~0.05 (flat). Stays under 16.7 ms across the measured range.

### Data load: setData plus first frame, ms

| Nodes | median ms | p95 ms | n | note |
| --- | --- | --- | --- | --- |
| 1,000 | 43.2 | 47.4 | 3 |  |
| 3,000 | 77.8 | 81.0 | 3 |  |
| 10,000 | 168 | 188 | 3 |  |
| 30,000 | 445 | 495 | 3 |  |
| 100,000 | 1064 | 1192 | 3 |  |
| 300,000 | 1874 | 2060 | 3 |  |

Scaling exponent ~0.69 (sub-linear). Over 16.7 ms at every measured size.

### Worker force layout, total ms

| Nodes | median ms | p95 ms | n | note |
| --- | --- | --- | --- | --- |
| 1,000 | 17.6 | 18.0 | 3 |  |
| 3,000 | 63.2 | 76.2 | 3 |  |
| 10,000 | 165 | 166 | 3 |  |
| 30,000 | 237 | 244 | 3 |  |
| 100,000 | 546 | 556 | 3 |  |
| 300,000 | 2215 | 2350 | 3 |  |

Scaling exponent ~0.77 (sub-linear). Over 16.7 ms at every measured size.

Columns marked n/a had no samples. Frame interval is capped by the display refresh in headless Chromium; use the CPU and GPU columns to compare renderer work.
