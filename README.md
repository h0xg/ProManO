# ProManO project page

A static research project website for *ProManO: Beyond Sim(3) for Metric Upgrade of Feed-Forward Geometry with Visual-Inertial Anchors*. Open the site through a local HTTP server to use the 3D viewer. No build step or external asset service is required.

## Content

- Paper and Code appear as disabled controls. The public site contains the interactive demonstrations and display assets.
- The façade comparison uses the same view and error scale for both alignments.
- Figure 5 provides eight further close-ups. The left side can show Ours w/ Sim(3) or Ours w/ ScaRF-SLAM, and the right side shows ProManO. Each comparison uses the paper's original images and indoor or outdoor surface-error scale.
- The sequence gallery contains eight top-down reconstructions from the paper. Colored camera poses show the estimated trajectory.
- The interactive viewer loads one scene on demand. Each preview samples 90,000 points from a ProManO reconstruction, retaining the original point colors. The four binary assets total 3.24 MB.
- The results selector reproduces the four feed-forward models in Table VII. Differences are reported in percentage points.

## Updating a 3D preview

Add a display sample to `assets/` and register it in `assets/scenes.json`. Each record occupies nine bytes: three little-endian signed 16-bit XYZ coordinates followed by three unsigned 8-bit RGB values. The coordinates use a common scale on all axes, with Y up. Divide positions by 32767 to get normalized coordinates. Multiply by the scene's `metresPerUnit` to convert distances to meters. Archive data and full-resolution point clouds stay on the research machines.

All asset references are relative, so the same checkout can be served from a GitHub Pages repository subpath.

