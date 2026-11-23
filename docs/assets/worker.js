/* Web Worker: runs one VRP job at a time (see VRP.createJob) and reports progress.
 *   page -> worker   {type: 'job', jobId, I, cfg}   |   {type: 'stop'}
 *   worker -> page   {type: 'progress', jobId, ...}  |   {type: 'done', jobId, ...result}
 *   page -> worker   {type: 'calibrate', reqId, I (first request only), mode, seconds, ops, k, code}  ->  {type: 'calibrated', reqId, iters}   (iterations that take ~seconds of compute)
 * Custom methods (cfg.mode === 'custom', code in cfg.code / m.code) are compiled here, never in the page. The page starts
 * such workers from a Blob so that they inherit its Content-Security-Policy (no network access); in addition the
 * network interfaces of the worker are removed before the code is compiled. */
'use strict';
if (typeof VRP === 'undefined') importScripts('vrp.js', 'methods.js');

(function () {
  let stopRequested = false, calI = null, locked = false, customCode = null;
  const post = self.postMessage.bind(self);

  function lockdown() {                              // best effort; the policy of the page is the actual barrier
    if (locked) return; locked = true;
    const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel',
      'Worker', 'SharedWorker', 'WebTransport', 'RTCPeerConnection', 'WebSocketStream', 'Request', 'navigator', 'postMessage'];
    for (const k of names) {
      for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) { try { delete o[k]; } catch (e) { /* ignore */ } }
      try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch (e) { /* ignore */ }
    }
  }
  function useCustom(code) {
    lockdown();
    if (code !== customCode) { VRP.setCustom(code); customCode = code; }
  }

  self.onmessage = e => {
    const m = e.data;
    if (m.type === 'stop') { stopRequested = true; return; }
    if (m.type === 'calibrate') {
      try {
        if (m.mode === 'custom') useCustom(m.code);
        post({ type: 'calibrated', reqId: m.reqId, iters: VRP.calibrate((m.I && (calI = m.I), calI), m.mode, m.seconds, { ops: m.ops, k: m.k }) });
      } catch (err) { post({ type: 'error', reqId: m.reqId, message: String(err && err.message || err) }); }
      return;
    }
    if (m.type !== 'job') return;
    stopRequested = false;
    let job;
    try { if (m.cfg.mode === 'custom') useCustom(m.cfg.code); job = VRP.createJob(m.I, m.cfg); }
    catch (err) { post({ type: 'error', jobId: m.jobId, message: String(err && err.message || err) }); return; }
    const tick = () => {
      let msg;
      try { msg = job.poll(80); } catch (err) { post({ type: 'error', jobId: m.jobId, message: String(err && err.message || err) }); return; }
      if (msg.done || stopRequested) {
        post(Object.assign({ type: 'done', jobId: m.jobId }, job.result(stopRequested && !msg.done)));
      } else {
        msg.type = 'progress'; msg.jobId = m.jobId; post(msg);
        setTimeout(tick, 0);                       // yields to the message queue so that 'stop' is seen
      }
    };
    tick();
  };
})();
