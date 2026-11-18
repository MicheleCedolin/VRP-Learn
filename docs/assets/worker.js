/* Web Worker: runs one VRP job at a time (see VRP.createJob) and reports progress.
 *   page -> worker   {type: 'job', jobId, I, cfg}   |   {type: 'stop'}
 *   worker -> page   {type: 'progress', jobId, ...}  |   {type: 'done', jobId, ...result}
 *   page -> worker   {type: 'calibrate', reqId, I (first request only), mode, seconds, ops, k}  ->  {type: 'calibrated', reqId, iters}   (iterations that take ~seconds of compute) */
'use strict';
importScripts('vrp.js', 'methods.js');

let stopRequested = false, calI = null;

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'stop') { stopRequested = true; return; }
  if (m.type === 'calibrate') {
    try { self.postMessage({ type: 'calibrated', reqId: m.reqId, iters: VRP.calibrate((m.I && (calI = m.I), calI), m.mode, m.seconds, { ops: m.ops, k: m.k }) }); }
    catch (err) { self.postMessage({ type: 'error', reqId: m.reqId, message: String(err && err.message || err) }); }
    return;
  }
  if (m.type !== 'job') return;
  stopRequested = false;
  let job;
  try { job = VRP.createJob(m.I, m.cfg); } catch (err) { self.postMessage({ type: 'error', jobId: m.jobId, message: String(err && err.message || err) }); return; }
  const tick = () => {
    let msg;
    try { msg = job.poll(80); } catch (err) { self.postMessage({ type: 'error', jobId: m.jobId, message: String(err && err.message || err) }); return; }
    if (msg.done || stopRequested) {
      self.postMessage(Object.assign({ type: 'done', jobId: m.jobId }, job.result(stopRequested && !msg.done)));
    } else {
      msg.type = 'progress'; msg.jobId = m.jobId; self.postMessage(msg);
      setTimeout(tick, 0);                       // yields to the message queue so that 'stop' is seen
    }
  };
  tick();
};
