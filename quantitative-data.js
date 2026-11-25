/* Canonical quantitative results for ProManO's project page.
 * Metric: reconstruction F1 in percent (higher is better). Indoor thresholds
 * are 5 cm; outdoor thresholds are 20 cm. Values are the paper's published
 * per-dataset Avg. columns across the listed sequences, not a new pooled or
 * cross-dataset average. Sources: main-paper Tables 2–4.
 *
 * "failure" represents the published ×: at least one sequence failed, so its
 * dataset mean is also ×. "unreported" means the paper supplies no result.
 * These are distinct states; neither is a zero score or an omitted success.
 *
 * Evaluation alignment: VO methods use Sim(3), while VIO methods use SE(3).
 * This evaluation gauge is separate from the Sim(3) reconstruction-backend
 * variant. The final three methods share the same frontend trajectory and
 * use DA3NESTED-GIANT-LARGE-1.1 as the default predictor. The ScaRF-SLAM row is
 * our mapping variant, not an independently evaluated full ScaRF-SLAM system.
 * Predictor pairs are [Ours w/ Sim(3), ProManO], in dataset order below.
 */
window.PROMANO_QUANTITATIVE = {
  datasets: [
    {id: 'euroc', name: 'EuRoC', thresholdCm: 5, sequences: 6, sourceTable: 'Table 2'},
    {id: 'cid', name: 'CID-SIMS', thresholdCm: 5, sequences: 8, sourceTable: 'Table 2'},
    {id: 'oxford', name: 'Oxford Spires', thresholdCm: 20, sequences: 9, sourceTable: 'Table 3'},
    {id: 'kitti', name: 'KITTI-360', thresholdCm: 20, sequences: 5, sourceTable: 'Table 3'}
  ],
  methods: [
    {id: 'lingbot', name: 'LingBot-Map', group: 'prior', values: [7.26, 27.08, 8.84, 0.12]},
    {id: 'loger', name: 'LoGeR', group: 'prior', values: [13.22, 26.87, 19.93, 'failure']},
    {id: 'scal3r', name: 'ScaL3R', group: 'prior', values: [16.92, 19.23, 'unreported', 'unreported']},
    {id: 'amb3r', name: 'AMB3R', group: 'prior', values: [5.12, 19.34, 17.99, 0.37]},
    {id: 'mast3r-slam', name: 'MASt3R-SLAM', group: 'prior', values: [48.20, 'failure', 'failure', 'failure']},
    {id: 'da3-streaming', name: 'DA3 Streaming', group: 'prior', values: [8.05, 30.80, 20.49, 0.10]},
    {id: 'mast3r-fusion', name: 'MASt3R-Fusion', group: 'prior', values: [42.17, 29.89, 37.35, 25.35]},
    {id: 'sim3', name: 'Ours w/ Sim(3)', group: 'sim3', values: [49.87, 40.49, 50.97, 24.85]},
    {id: 'scarf', name: 'Ours w/ ScaRF-SLAM', group: 'scarf', values: [47.54, 34.86, 53.49, 24.40]},
    {id: 'ours', name: 'ProManO', group: 'ours', values: [53.99, 45.24, 60.74, 29.09]}
  ],
  predictors: [
    {
      id: 'nested', name: 'DA3-Nested', fullName: 'DA3NESTED-GIANT-LARGE-1.1',
      pairs: [[49.87, 53.99], [40.49, 45.24], [50.97, 60.74], [24.85, 29.09]]
    },
    {
      id: 'large', name: 'DA3-LARGE',
      pairs: [[43.32, 49.60], [33.33, 37.23], [48.52, 57.83], [22.32, 28.68]]
    },
    {
      id: 'pi3x', name: 'Pi3X',
      pairs: [[49.56, 52.67], [40.29, 44.11], [59.63, 64.32], [25.11, 29.69]]
    },
    {
      id: 'vggt', name: 'VGGT-Ω',
      pairs: [[46.32, 48.53], [36.65, 40.99], [58.69, 62.97], [24.77, 28.85]]
    }
  ],
  sources: {benchmark: 'Tables 2–3', predictors: 'Table 4'}
};
