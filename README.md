# ProManO project page

A static research project website for *ProManO: Beyond Sim(3) for Metric Upgrade of Feed-Forward Geometry with Visual-Inertial Anchors*. Open the site through a local HTTP server to use the 3D viewer. No build step or external asset service is required.

## Content

- The site uses a dark blue, violet and cyan theme. Scientific figures retain their original colors. The citation section is deferred until the reference is finalized.
- The overview compares Sim(3), SL(4) and ProManO with an interactive, synthetic single-camera geometry example. It illustrates their 7/15/10 degrees of freedom and fixed-calibration constraint. Pose is aligned to isolate Sim(3)'s common scale and ProManO's depth-dependent multiplier; both act along camera rays. The SL(4) example is one allowed calibration-changing mode, not an estimated SLAM result. Measured reconstruction comparisons follow in one shared section.

- The opening SLAM replays synchronize original input images, real six-axis IMU measurements, and the estimated camera poses from three recorded ProManO runs: EuRoC V1_02_medium, CID-SIMS Apartment 3, and Oxford Spires Keble College 05. Maps start empty and grow from the recorded per-keyframe depth contributions in acquisition order. Each sequence is accelerated to 20 seconds and uses the final ProManO calibration; it demonstrates reconstruction order, not online inference latency.
- The replay player provides sequence selection, a shared timeline, playback speed, a camera-follow view, an orbit view, a global overview, and full screen. Visible replays start automatically and loop the camera, growing map and IMU together. They pause outside the viewport and in background tabs, then resume on return; an explicit Pause stays paused. Reduced-motion preferences disable automatic playback. A `?scene=euroc`, `?scene=cid`, or `?scene=oxford` URL selects a replay.
- Paper and Code appear as disabled controls. The public site contains the interactive demonstrations and display assets.
- Reconstruction comparisons combine the Oxford façade and eight Figure 5 close-ups in one grid with shared dataset and baseline controls. The façade supports Sim(3) only and is hidden for ScaRF-SLAM; the other eight support both baselines. Each card retains its original local error scale: façade 0–3 m, outdoor close-ups 0–1 m, and indoor close-ups 0–0.2 m. Gray means LiDAR ground truth in the façade and ground-truth surface missed by all three methods in the close-ups.
- The sequence gallery contains eight top-down reconstructions from the paper. Colored camera poses show the estimated trajectory.
- The interactive viewer loads one scene on demand. Each preview samples 90,000 points from a ProManO reconstruction, retaining the original point colors. The four binary assets total 3.24 MB.
- Quantitative results use fixed 0–100 F₁ charts for the ten methods in Tables 2–3, with a filter for the three mapping variants that share the frontend. Each dataset card states its sequence count and evaluation threshold. Tracking failures and unreported values remain distinct states. A second interactive view compares four predictors on each dataset using Table 4, with gains in percentage points. Charts and expandable exact-value tables read the same audited `quantitative-data.js` source.

## Updating a 3D preview

Add a display sample to `assets/` and register it in `assets/scenes.json`. Each record occupies nine bytes: three little-endian signed 16-bit XYZ coordinates followed by three unsigned 8-bit RGB values. The coordinates use a common scale on all axes, with Y up. Divide positions by 32767 to get normalized coordinates. Multiply by the scene's `metresPerUnit` to convert distances to meters. Archive data and full-resolution point clouds stay on the research machines.

All asset references are relative, so the same checkout can be served from a GitHub Pages repository subpath.

## Replay assets

`assets/demos/scenes.json` describes the replay assets. Each cloud uses the nine-byte packed format above. Cloud coordinates and camera centers share the same origin, scale, and Y-up rotation. Frame records contain the replay time, original capture time, camera center, and the camera's right/up/forward basis vectors. The silent H.264 input videos contain the same 160 sampled camera frames at 8 fps. Camera poses are matched to the reconstruction's own recorded camera file rather than mixed across experiment versions.

`frames[].pointCount` gives the cumulative visible point count. `contributions[]` identifies the real source keyframe and submap behind each point batch. Points are reconstructed from the recorded depth and ProManO correction, rather than assigning artificial appearance times to a completed PLY.

Each scene's `imu.json` contains real accelerometer and gyroscope samples, in m/s² and rad/s with sensor XYZ axes and gravity retained. The export preserves the six-axis extrema in time bins and the IMU sample nearest every displayed camera frame. Its metadata records the timestamp alignment and sampling method. The plots use the same replay clock as the camera and map.

The scripts in `tools/` rebuild the video, progressive geometry, and IMU samples from local experiment files; see `tools/README.md`. Exports stream source data in bounded chunks and should run in resource-limited services. Private source paths and full-resolution research data are not part of this repository.

## GitHub Pages

The public project page is **https://h0xg.github.io/ProManO/**. Pages publishes the root of the `main` branch; `.nojekyll` keeps the buildless assets intact. Updating `main` triggers the existing Pages deployment. No framework build or additional workflow is required.

For local preview, run `python3 -m http.server 8000` in the checkout and visit `http://localhost:8000/`.

