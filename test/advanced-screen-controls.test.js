const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const vm = require('node:vm');

const clientHtml = fs.readFileSync(path.join(__dirname, '..', 'client.html'), 'utf8');

function extractFunctions(...namesAndNextMarkers) {
  return namesAndNextMarkers.map(([name, nextName]) => {
    let start = clientHtml.indexOf(`function ${name}(`);
    if (start === -1) {
      start = clientHtml.indexOf(`async function ${name}(`);
    }
    if (start === -1) {
      throw new Error(`missing production function: ${name}`);
    }
    const regularEnd = clientHtml.indexOf(`\nfunction ${nextName}(`, start);
    const asyncEnd = clientHtml.indexOf(`\nasync function ${nextName}(`, start);
    const end = regularEnd < 0 ? asyncEnd : asyncEnd < 0 ? regularEnd : Math.min(regularEnd, asyncEnd);
    if (end === -1) {
      throw new Error(`missing end marker for production function: ${name} (looking for ${nextName})`);
    }
    return clientHtml.slice(start, end);
  }).join('\n');
}

function createScreenControlsHarness() {
  const state = {
    fitMode: 'fit',
    screenZoom: 100,
    screenRotation: 0,
    screenPanX: 0,
    screenPanY: 0,
    remoteFullscreen: false
  };
  
  const elements = {
    rdStage: {
      classList: {
        toggle: function(cls, force) {
          this[cls] = force !== undefined ? force : !this[cls];
        },
        add: function(cls) { this[cls] = true; },
        remove: function(cls) { this[cls] = false; },
        fit: false,
        actual: false,
        panning: false,
        fullscreen: false
      }
    },
    rdImg: {
      style: { transform: '' }
    },
    fitBtn: { classList: { toggle: () => {} } },
    actualBtn: { classList: { toggle: () => {} } },
    zoomLevel: { textContent: '100%' }
  };
  
  const transformCalls = [];
  
  const sandbox = {
    state,
    document: {
      getElementById: (id) => elements[id] || null
    },
    $: (id) => elements[id] || null,
    ZOOM_LEVELS: [50, 75, 100, 125, 150, 175, 200, 250, 300],
    applyScreenTransform: function() {
      const img = sandbox.document.getElementById('rdImg');
      if (!img) return;
      
      const zoom = sandbox.state.screenZoom / 100;
      const rotation = sandbox.state.screenRotation;
      const panX = sandbox.state.screenPanX;
      const panY = sandbox.state.screenPanY;
      
      img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom}) rotate(${rotation}deg)`;
      transformCalls.push({ zoom, rotation, panX, panY });
    },
    transformCalls
  };
  
  const SOURCE = extractFunctions(
    ['zoomScreen', 'rotateScreen'],
    ['rotateScreen', 'applyScreenTransform']
  );
  
  vm.runInNewContext(`${SOURCE}\nthis.zoomScreen = zoomScreen; this.rotateScreen = rotateScreen;`, sandbox);
  
  return { sandbox, state, elements, transformCalls };
}

// ============================================================================
// Zoom Tests
// ============================================================================

test('zoom starts at 100%', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { state } = harness;
  
  assert.equal(state.screenZoom, 100);
});

test('zoom in increases zoom level', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, state } = harness;
  
  sandbox.zoomScreen('in');
  assert.equal(state.screenZoom, 125);
  
  sandbox.zoomScreen('in');
  assert.equal(state.screenZoom, 150);
});

test('zoom out decreases zoom level', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, state } = harness;
  
  state.screenZoom = 150;
  sandbox.zoomScreen('out');
  assert.equal(state.screenZoom, 125);
  
  sandbox.zoomScreen('out');
  assert.equal(state.screenZoom, 100);
});

test('zoom reset returns to 100% and clears pan', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, state } = harness;
  
  state.screenZoom = 200;
  state.screenPanX = 50;
  state.screenPanY = 30;
  
  sandbox.zoomScreen('reset');
  
  assert.equal(state.screenZoom, 100);
  assert.equal(state.screenPanX, 0);
  assert.equal(state.screenPanY, 0);
});

test('zoom respects minimum level (50%)', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, state } = harness;
  
  state.screenZoom = 50;
  sandbox.zoomScreen('out');
  
  assert.equal(state.screenZoom, 50); // Should stay at minimum
});

test('zoom respects maximum level (300%)', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, state } = harness;
  
  state.screenZoom = 300;
  sandbox.zoomScreen('in');
  
  assert.equal(state.screenZoom, 300); // Should stay at maximum
});

test('zoom > 100% adds panning class', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, elements } = harness;
  
  sandbox.zoomScreen('in'); // Goes to 125%
  
  assert.equal(elements.rdStage.classList.panning, true);
});

test('zoom <= 100% removes panning class and clears pan', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, state, elements } = harness;
  
  state.screenZoom = 150;
  state.screenPanX = 50;
  state.screenPanY = 30;
  elements.rdStage.classList.panning = true;
  
  sandbox.zoomScreen('out'); // Goes to 125%
  sandbox.zoomScreen('out'); // Goes to 100%
  
  assert.equal(elements.rdStage.classList.panning, false);
  assert.equal(state.screenPanX, 0);
  assert.equal(state.screenPanY, 0);
});

test('zoom updates zoom level display', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, elements } = harness;
  
  sandbox.zoomScreen('in');
  assert.equal(elements.zoomLevel.textContent, '125%');
  
  sandbox.zoomScreen('in');
  assert.equal(elements.zoomLevel.textContent, '150%');
});

// ============================================================================
// Rotation Tests
// ============================================================================

test('rotation starts at 0 degrees', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { state } = harness;
  
  assert.equal(state.screenRotation, 0);
});

test('rotation cycles through 90, 180, 270, 0', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, state } = harness;
  
  sandbox.rotateScreen();
  assert.equal(state.screenRotation, 90);
  
  sandbox.rotateScreen();
  assert.equal(state.screenRotation, 180);
  
  sandbox.rotateScreen();
  assert.equal(state.screenRotation, 270);
  
  sandbox.rotateScreen();
  assert.equal(state.screenRotation, 0);
});

// ============================================================================
// Transform Application Tests
// ============================================================================

test('applyScreenTransform applies correct CSS transform', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, state, elements } = harness;
  
  state.screenZoom = 150;
  state.screenRotation = 90;
  state.screenPanX = 20;
  state.screenPanY = 30;
  
  sandbox.applyScreenTransform();
  
  assert.equal(elements.rdImg.style.transform, 'translate(20px, 30px) scale(1.5) rotate(90deg)');
});

test('applyScreenTransform with default values', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, elements } = harness;
  
  sandbox.applyScreenTransform();
  
  assert.equal(elements.rdImg.style.transform, 'translate(0px, 0px) scale(1) rotate(0deg)');
});

test('zoom calls applyScreenTransform', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, transformCalls } = harness;
  
  const initialCount = transformCalls.length;
  sandbox.zoomScreen('in');
  
  assert.equal(transformCalls.length, initialCount + 1);
  assert.equal(transformCalls[transformCalls.length - 1].zoom, 1.25);
});

test('rotation calls applyScreenTransform', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, transformCalls } = harness;
  
  const initialCount = transformCalls.length;
  sandbox.rotateScreen();
  
  assert.equal(transformCalls.length, initialCount + 1);
  assert.equal(transformCalls[transformCalls.length - 1].rotation, 90);
});

// ============================================================================
// Integration Tests
// ============================================================================

test('zoom, pan, and rotation work together', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, state, elements } = harness;
  
  // Zoom in
  sandbox.zoomScreen('in');
  assert.equal(state.screenZoom, 125);
  
  // Rotate
  sandbox.rotateScreen();
  assert.equal(state.screenRotation, 90);
  
  // Pan (manually set)
  state.screenPanX = 40;
  state.screenPanY = 50;
  
  // Apply transform
  sandbox.applyScreenTransform();
  
  const expected = 'translate(40px, 50px) scale(1.25) rotate(90deg)';
  assert.equal(elements.rdImg.style.transform, expected);
});

test('zoom levels follow defined progression', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, state } = harness;
  
  const expected = [100, 125, 150, 175, 200, 250, 300];
  
  for (let i = 0; i < expected.length - 1; i++) {
    sandbox.zoomScreen('in');
  }
  
  assert.equal(state.screenZoom, 300);
  
  // Zoom back down
  for (let i = 0; i < expected.length - 1; i++) {
    sandbox.zoomScreen('out');
  }
  
  assert.equal(state.screenZoom, 100);
});

test('zoom below 100% available via out button', { concurrency: false }, () => {
  const harness = createScreenControlsHarness();
  const { sandbox, state } = harness;
  
  sandbox.zoomScreen('out');
  assert.equal(state.screenZoom, 75);
  
  sandbox.zoomScreen('out');
  assert.equal(state.screenZoom, 50);
});
