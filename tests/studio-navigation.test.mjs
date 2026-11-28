import assert from 'node:assert/strict';
import test from 'node:test';
import { createAreaBus } from '../src/host/area-bus.mjs';
import { installStudioNavigation } from '../src/studio/studio-navigation.mjs';

const origin = 'http://127.0.0.1:9999';
const target = { projectId: 'project1', sessionId: 'chat-1', requestId: 1 };
const message = target => ({ type: 'no996-openfilm:navigate', version: 1, ...target });

function frame(path = '/', state = null) {
  const win = new EventTarget();
  const replies = [], reports = [];
  win.parent = { postMessage: (reply, to) => { assert.equal(to, origin); replies.push(reply); } };
  win.location = { pathname: path, assign: next => { win.location.pathname = next; } };
  win.CustomEvent = CustomEvent;
  win.PopStateEvent = Event;
  win.history = {
    state,
    replaceState(next, _title, path) { this.state = next; if (path) win.location.pathname = path; },
    pushState(next, title, path) { this.replaceState(next, title, path); },
  };
  installStudioNavigation({ win, parentOrigin: origin, targetOrigin: origin, desktop: false, reportProject: force => reports.push(force) });
  const send = (data, sender = win.parent, eventOrigin = origin) => {
    const event = new Event('message');
    Object.assign(event, { data, source: sender, origin: eventOrigin });
    win.dispatchEvent(event);
  };
  const shown = detail => win.dispatchEvent(new CustomEvent('no996-openfilm:editing-shown', { detail }));
  return { win, replies, reports, send, shown };
}

test('a stale project report or ACK cannot overtake the current exact target', () => {
  const bus = createAreaBus();
  const events = [];
  bus.subscribe(event => events.push(event));
  assert.equal(bus.navigate('project1', 'chat-1'), true);
  assert.deepEqual(bus.pendingTarget(), target);
  assert.equal(bus.reportProject('project1'), false, 'URL is not a chat ACK');
  assert.equal(bus.navigate('project2', 'chat-2'), true);
  const newest = bus.pendingTarget();
  assert.equal(bus.acknowledge({ ...target, status: 'ready' }), false);
  assert.equal(bus.acknowledge({ ...newest, sessionId: 'chat-1', status: 'ready' }), false);
  assert.equal(bus.reportProject('project1'), false);
  assert.equal(bus.pendingTarget(), newest, 'the target can be replayed on the next frame boot');
  assert.equal(bus.acknowledge({ ...newest, status: 'ready' }), true);
  assert.equal(bus.pendingTarget(), null);
  assert.deepEqual(events.at(-1), { type: 'project', projectId: 'project2' });
});

test('invalid session input does not turn into a project-only navigation', () => {
  const bus = createAreaBus();
  assert.equal(bus.navigate('project1', '../bad'), false);
  assert.equal(bus.pendingTarget(), null);
  assert.equal(bus.navigate('project1'), true);
  assert.equal(bus.reportProject('project2'), false);
  assert.equal(bus.reportProject('project1'), true);
  assert.equal(bus.pendingTarget(), null);
});

test('reload reopens the exact target, duplicates do not reset it, and user selection clears it', () => {
  const old = frame();
  old.send(message(target));
  assert.deepEqual(old.win.__no996PendingSession, target);
  assert.equal(old.win.location.pathname, '/projects/project1');
  const fresh = frame(old.win.location.pathname, structuredClone(old.win.history.state));
  assert.deepEqual(fresh.win.__no996PendingSession, target);
  const retained = fresh.win.__no996PendingSession;
  fresh.send(message(target));
  assert.equal(fresh.win.__no996PendingSession, retained);
  fresh.shown({ ...target, requestId: 2 });
  assert.equal(fresh.replies.length, 0);
  fresh.shown(target);
  assert.deepEqual(fresh.replies[0], { type: 'no996-openfilm:navigation-result', version: 1, ...target, status: 'ready' });
  fresh.shown({ projectId: target.projectId, sessionId: 'other-chat' });
  assert.equal(frame(fresh.win.location.pathname, fresh.win.history.state).win.__no996PendingSession, undefined);
});

test('foreign messages are ignored and leaving the route cancels an unresolved handoff', () => {
  const testFrame = frame();
  testFrame.send(message(target), testFrame.win.parent, 'https://foreign.invalid');
  testFrame.send(message(target), {});
  assert.equal(testFrame.win.__no996PendingSession, undefined);
  testFrame.send(message(target));
  testFrame.win.history.pushState({}, '', '/projects/project2');
  testFrame.win.dispatchEvent(new Event('popstate'));
  assert.equal(testFrame.win.__no996PendingSession, undefined);
  assert.equal(testFrame.replies[0]?.status, 'cancelled');
  assert.deepEqual(testFrame.reports, [true]);
});
