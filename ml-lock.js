// One ML job at a time, shared by the lab's manual runs (ml-routes.js) and the idle auto-runner (ml-auto.js).
// A manual run always wins: if the auto-runner is in the middle of a job, it is stopped (the job is simply tried again later) so that the
// person who just pressed a button never has to wait for a background job.
const lock = { token: null, owner: '', preempt: null };
module.exports = {
  isBusy: () => lock.token !== null,
  owner: () => lock.owner,
  canTake: (owner = 'manual') => lock.token === null || (owner !== 'auto' && lock.owner === 'auto' && typeof lock.preempt === 'function'),
  // returns a token (keep it, pass it to release) or null when somebody else holds the lock
  acquire(owner = 'manual', preempt = null) {
    if (lock.token !== null) {
      if (!(owner !== 'auto' && lock.owner === 'auto' && typeof lock.preempt === 'function')) return null;
      try { lock.preempt(); } catch { /* the auto job is abandoned either way */ }
      lock.token = null; lock.owner = ''; lock.preempt = null;
    }
    lock.token = {}; lock.owner = owner; lock.preempt = preempt;
    return lock.token;
  },
  release(token) { if (token && lock.token === token) { lock.token = null; lock.owner = ''; lock.preempt = null; } }, // a stale token (after being preempted) does nothing
  _reset() { lock.token = null; lock.owner = ''; lock.preempt = null; },
};
