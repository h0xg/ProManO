# Export recorded SLAM demos

The published demos replay real per-keyframe depth contributions in acquisition
order. `export_slam_demos.py` first builds synchronized input videos, camera
poses, and fixed display bounds. `export_progressive_demos.py` then replaces
the temporary final-map sample with points reconstructed from each recorded
keyframe's DA3 depth and final ProManO calibration. Both scripts are required
to produce the published growing-map replay.

Install Python with NumPy, Pillow, SciPy and OpenCV, and an `ffmpeg` binary with `libx264`.
Create a local JSON configuration array, with one object per sequence:

```json
[
  {
    "id": "example",
    "title": "Dataset · Sequence",
    "dataset": "Dataset",
    "sequence": "Sequence",
    "cloud": "/path/to/run/qc/map/promano_final.ply",
    "cameras": "/path/to/mapping/keyframes/cameras.json"
  }
]
```

The adjacent `summary.json` must identify this camera file in
`args.cameras_json`. Camera records must contain `timestamp_ns`, `image_path`,
and the OpenCV camera-to-world matrix `T_w_c`. These gravity-aligned VIO runs
use Z-up; the exporter rotates the world to Y-up for display. Camera `up` is
the negative image-Y axis and `forward` is the optical axis.

Run the exporter in a separate, resource-limited service. Keep `--scratch`
outside the repository: it stores intermediate JPEGs and private provenance,
including the local source paths.

```bash
systemd-run --user --collect --unit=promano-demo-export \
  -p MemoryMax=2G -p MemoryHigh=1500M -p CPUQuota=100% -p TasksMax=24 \
  /usr/bin/env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  /path/to/python tools/export_slam_demos.py \
  --config /path/to/local-config.json \
  --destination assets/demos --scratch /path/to/private-scratch
```

The exporter reads binary little-endian PLY vertices sequentially in 8-MiB
blocks. It takes a deterministic stratified sample, removes display outliers
outside the per-axis 0.3–99.7 percentiles, and retains up to 120,000 points.
The final sample and all source camera positions share a single centering,
rotation, and scale; archived research data is never modified.

Each scene contains a `cloud.bin` with nine bytes per vertex: three
little-endian signed 16-bit coordinates, then three unsigned 8-bit colors.
Divide coordinates by 32767 to get display units. `metresPerUnit` converts a
display distance to metres. The H.264 input video contains 160 frames at 8 fps
with no audio. Each video frame and manifest camera pose uses the same nearest
source keyframe, sampled at uniform source-time intervals. Playback is 20
seconds; `sourceDuration` reports the recorded duration. No synthesized video
frames or per-point observation timestamps are introduced.

After the first export, run the contribution exporter in the same bounded
service style, retaining the private scratch directory:

```bash
systemd-run --user --collect --unit=promano-progressive-export \
  -p MemoryMax=2G -p MemoryHigh=1500M -p CPUQuota=100% -p TasksMax=24 \
  /usr/bin/env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  /path/to/python tools/export_progressive_demos.py \
  --config /path/to/local-config.json --root . \
  --scratch /path/to/private-scratch
```

This reads the original run's DA3 `manifest.json` and one compressed depth
submap at a time. It uses exactly the original dense exporter's first-owner
submap rule, sky mask, calibrated pixel rays, affine inverse-depth correction,
final submap rotation/scale/translation, and depth range. Source RGB comes from
the same keyframe. It samples a display budget of about 180,000 points,
stratified by source keyframe; only the within-frame spatial sample is random
and deterministically seeded. Point batches are ordered by their real global
keyframe index. No point from the final PLY is assigned a fabricated birth time.

`frames[].pointCount` controls the rendered prefix, beginning at zero and
growing with the matched source timestamp. `contributions[]` records each
batch's source keyframe, timestamp, submap, offset, and count. Scrubbing backward
reduces the prefix. Both camera and overview views must use this same prefix.

This is an offline replay of final-corrected reconstruction contributions.
The source DA3 submaps use multi-frame context and the ProManO calibration
comes from the completed optimization. The replay therefore demonstrates
acquisition order and cumulative geometry, not online inference latency or
wall-clock execution speed.

## Export recorded IMU signals

`export_demo_imu.py` runs once per scene, after its `scene.json` exists. It uses
the Python standard library and accepts the explicit arguments below; it does
not accept `--config` or `--root`.

The input CSV must have seven columns in this order, without a header or with
comment lines beginning with `#`:

```text
timestamp_ns,gyro_x,gyro_y,gyro_z,accel_x,accel_y,accel_z
```

`timestamp_ns` must be a strictly increasing integer nanosecond timestamp;
gyro values must already be in rad/s and accelerometer values in m/s². Confirm
the original units and camera/IMU clock relation from the dataset and frozen
preprocessing records before exporting. This script does not convert units or
apply a camera/IMU offset. If preprocessing has already shifted camera
timestamps onto the IMU clock, do not apply that shift again.

```bash
systemd-run --user --collect --unit=promano-demo-imu-export \
  -p MemoryMax=1G -p CPUQuota=50% \
  /path/to/python tools/export_demo_imu.py \
  --scene assets/demos/example/scene.json \
  --imu-csv /path/to/recorded/imu0.csv \
  --out assets/demos/example/imu.json \
  --max-samples 1600 \
  --clock-evidence 'Describe the verified shared clock or previously applied camera time shift.' \
  --unit-evidence 'Identify the source unit declaration or frozen SI sensor export.'
```

All arguments except `--max-samples` are required. Its default is 1600 and its
minimum is 400. The two evidence strings are published in the output: describe
the evidence without including private local paths. The source file is read
only; the output includes its SHA-256, original median sampling rate, retained
sample count, and nearest-sample timing error at the camera anchors.

The output schema is `promano-recorded-imu-v1`. Its signal payload is:

```text
{
  schema: "promano-recorded-imu-v1",
  scene: "example",
  source: "dataset sensor recording",
  accelUnit: "m/s²",
  gyroUnit: "rad/s",
  sensorFrame: "Original IMU sensor XYZ axes",
  sampleRateOriginal: <median source rate in Hz>,
  decimated: true,
  samples: [
    {
      time: <seconds on the 0–20-second demo timeline>,
      sourceTime: <original sensor timestamp in seconds>,
      accel: [<x>, <y>, <z>],
      gyro: [<x>, <y>, <z>]
    }
  ]
}
```

Replay times use a piecewise linear map between each pair of
`frames[].sourceTime` and `frames[].time` anchors. Repeated camera timestamps
hold the nearest real IMU sample; the final video frame is held to the clip
end. Thus the IMU replay follows the same selected source keyframes as the
video, including repeated frames. Only replay times are interpolated.

To keep the browser payload small, equal replay-time bins retain the union of
the six channels' minimum and maximum **whole recorded sample rows**, plus the
nearest real sample at every video-frame anchor. This preserves measured peaks
while staying within the sample budget. Sensor XYZ axes and the original
accelerometer response, including gravity, are retained; values are rounded to
seven decimal places for display. No sine waves, synthetic measurements,
smoothed signals, or interpolated measurement values are generated.
