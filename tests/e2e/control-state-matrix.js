import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

export const CONTROL_VIEWPORTS = [
  { name: 'phone-320', width: 320, height: 844 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'tablet-768', width: 768, height: 900 },
  { name: 'desktop-1440', width: 1440, height: 900 }
];

const EXPECTED_VALUES = [
  'restore', 'auto-asc', 'mass-asc', 'volume-asc', 'count-asc', 'total-asc'
];

export async function captureControlStateMatrix(page, {
  outputDirectory, setup, enterPending, exitPending, enterNoMatch, exitNoMatch,
  enterFilteredRestore, exitFilteredRestore
}) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const evidence = [];
  const capture = async (viewport, state) => {
    // Capture the intentional post-layout state, not an interpolated control transition.
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({
      path: path.join(outputDirectory, `${viewport.name}-${state}.png`),
      fullPage: false
    });
    evidence.push(await page.locator('#lups-control').evaluate((control, context) => {
      const rect = (selector = null) => {
        const element = selector ? control.querySelector(selector) : control;
        if (!element || element.hidden) return null;
        const computed = getComputedStyle(element);
        if (computed.display === 'none' || computed.visibility === 'hidden' || Number(computed.opacity) === 0) return null;
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      const styles = (selector) => {
        const element = control.querySelector(selector);
        if (!element) return null;
        const computed = getComputedStyle(element);
        return Object.fromEntries([
          'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor',
          'border', 'borderRadius', 'boxShadow', 'padding', 'gap', 'position', 'zIndex'
        ].map((property) => [property, computed[property]]));
      };
      const annotations = [...document.querySelectorAll('[data-lups-annotation]')];
      const menuVisible = !control.querySelector('#lups-menu-host')?.hidden;
      const menuItems = [...control.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')];
      const menuItemBoxes = menuVisible ? menuItems.map((item) => item.getBoundingClientRect()) : [];
      const optionText = menuVisible
        ? [...control.querySelectorAll('.lups-option-title,.lups-option-detail')]
        : [];
      const annotationOutOfBoundsCount = annotations.filter((note) => {
        const card = note.closest('.market-card') || note.parentElement;
        const noteBox = note.getBoundingClientRect();
        const cardBox = card?.getBoundingClientRect();
        const computed = getComputedStyle(note);
        return !cardBox || noteBox.width <= 0 || noteBox.height <= 0
          || computed.display === 'none' || computed.visibility === 'hidden'
          || noteBox.left < cardBox.left - 1 || noteBox.right > cardBox.right + 1
          || noteBox.top < cardBox.top - 1 || noteBox.bottom > cardBox.bottom + 1;
      }).length;
      return {
        viewport: context.viewport,
        state: context.state,
        mode: control.dataset.lupsMode,
        restored: control.dataset.lupsRestored,
        dataState: control.dataset.lupsDataState,
        buttonText: control.querySelector('#lups-menu-button-text')?.textContent,
        statusText: control.querySelector('#lups-status')?.textContent,
        announcementText: control.querySelector('#lups-live-status')?.textContent,
        optionValues: [...control.querySelectorAll('[data-lups-value]')].map((item) => item.dataset.lupsValue),
        statusRoleCount: control.querySelectorAll('[role="status"], [aria-live]').length,
        annotationCount: annotations.length,
        annotationOutOfBoundsCount,
        inlineOrderCount: [...document.querySelectorAll('#grid > *')]
          .filter((card) => card.style.getPropertyValue('order')).length,
        overflowCueVisible: !control.querySelector('.lups-menu-overflow-cue')?.hidden,
        menuScroll: menuVisible ? {
          top: control.querySelector('#lups-menu')?.scrollTop,
          height: control.querySelector('#lups-menu')?.scrollHeight,
          viewport: control.querySelector('#lups-menu')?.clientHeight
        } : null,
        menuItemMinimumSize: menuVisible ? {
          width: Math.min(...menuItemBoxes.map((box) => box.width)),
          height: Math.min(...menuItemBoxes.map((box) => box.height))
        } : null,
        clippedOptionTextCount: optionText.filter((item) => item.scrollWidth > item.clientWidth + 1).length,
        geometry: {
          control: rect(),
          trigger: rect('.lups-trigger-row'),
          menu: rect('#lups-menu-host'),
          status: rect('#lups-status-row'),
          reverse: rect('#lups-flip-direction'),
          defaultAction: rect('#lups-default')
        },
        computedStyles: {
          trigger: styles('#lups-menu-button'),
          menu: styles('#lups-menu'),
          status: styles('#lups-status-row'),
          annotations: Object.fromEntries(['retailer', 'calculated', 'unknown'].map((source) => {
            const note = document.querySelector(`[data-lups-annotation][data-source="${source}"]`);
            if (!note) return [source, null];
            const computed = getComputedStyle(note);
            return [source, {
              font: computed.font,
              color: computed.color,
              backgroundColor: computed.backgroundColor,
              border: computed.border,
              borderRadius: computed.borderRadius
            }];
          }))
        }
      };
    }, { viewport, state }));
  };

  for (const viewport of CONTROL_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await setup(viewport);
    await expect(page.locator('#lups-control')).toHaveCount(1);
    await expect.poll(() => page.locator('[data-lups-annotation]').count()).toBeGreaterThan(0);
    await capture(viewport, 'restored-closed');
    await page.locator('#lups-menu-button').hover();
    await capture(viewport, 'restored-tooltip');
    if (enterFilteredRestore && exitFilteredRestore) {
      await enterFilteredRestore(viewport);
      await expect(page.locator('#lups-status')).toHaveText('Website order · 8 loaded products · 1 sponsored/ad tile hidden');
      await page.locator('#lups-menu-button').hover();
      await expect(page.locator('#lups-status-row')).toBeVisible();
      await capture(viewport, 'restored-filtered');
      await exitFilteredRestore(viewport);
      await page.locator('h1').click();
      await expect(page.locator('#lups-status-row')).toBeHidden();
    }
    await page.locator('#lups-menu-button').click();
    await capture(viewport, 'restored-menu-open');
    await page.locator('[data-lups-value="auto-asc"]').click();
    await page.locator('#lups-menu-button').hover();
    await capture(viewport, 'automatic-ascending');
    if (enterPending && exitPending) {
      await enterPending(viewport);
      await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-data-state', 'pending');
      await expect(page.locator('[data-lups-annotation]')).toHaveCount(0);
      await capture(viewport, 'pending-automatic-ascending');
      await exitPending(viewport);
      await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-data-state', 'ready');
      await expect.poll(() => page.locator('[data-lups-annotation]').count()).toBeGreaterThan(0);
    }
    if (enterNoMatch && exitNoMatch) {
      await enterNoMatch(viewport);
      await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-data-state', 'no-match');
      await expect(page.locator('[data-lups-annotation]')).toHaveCount(0);
      await capture(viewport, 'no-match-automatic-ascending');
      await exitNoMatch(viewport);
      await expect(page.locator('#lups-control')).toHaveAttribute('data-lups-data-state', 'ready');
      await expect.poll(() => page.locator('[data-lups-annotation]').count()).toBeGreaterThan(0);
    }
    await page.locator('#lups-flip-direction').click();
    await capture(viewport, 'automatic-descending');
    await page.locator('#lups-menu-button').click();
    await capture(viewport, 'automatic-descending-menu-open');
    await page.locator('[data-lups-value="restore"]').click();
  }

  await fs.writeFile(
    path.join(outputDirectory, 'state-matrix.json'),
    `${JSON.stringify({ states: evidence }, null, 2)}\n`
  );
  return evidence;
}

export async function captureForcedColorsControl(page, { outputDirectory, setup }) {
  await fs.mkdir(outputDirectory, { recursive: true });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.setViewportSize({ width: 390, height: 844 });
  await setup({ name: 'forced-colors-390', width: 390, height: 844 });
  await expect(page.locator('#lups-control')).toHaveCount(1);
  await expect.poll(() => page.locator('[data-lups-annotation]').count()).toBeGreaterThan(0);
  await page.locator('#lups-menu-button').click();
  await page.locator('[data-lups-value="auto-asc"]').click();
  await page.locator('#lups-menu-button').focus();
  await page.keyboard.press('Enter');
  const selected = page.locator('[data-lups-value="auto-asc"]');
  await expect(selected).toHaveAttribute('aria-checked', 'true');
  await expect(selected).toBeFocused();
  await expect(selected.locator('[data-lups-tick]')).toBeVisible();
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const evidence = await page.locator('#lups-control').evaluate((control) => {
    const menuItems = [...control.querySelectorAll('[data-lups-value]')];
    const selectedItem = control.querySelector('[data-lups-value="auto-asc"]');
    const selectedStyle = getComputedStyle(selectedItem.querySelector('.lups-option-icon'));
    const selectedFocusStyle = getComputedStyle(selectedItem);
    const selectedBox = selectedItem.getBoundingClientRect();
    const menuBox = control.querySelector('#lups-menu-host').getBoundingClientRect();
    const optionText = [...control.querySelectorAll('.lups-option-title,.lups-option-detail')];
    const annotations = Object.fromEntries(['retailer', 'calculated', 'unknown'].map((source) => {
      const note = document.querySelector(`[data-lups-annotation][data-source="${source}"]`);
      const style = note ? getComputedStyle(note) : null;
      return [source, style ? {
        borderStyle: style.borderStyle,
        borderWidth: style.borderWidth,
        color: style.color,
        backgroundColor: style.backgroundColor
      } : null];
    }));
    return {
      forcedColorsActive: matchMedia('(forced-colors: active)').matches,
      mode: control.dataset.lupsMode,
      dataState: control.dataset.lupsDataState,
      selected: selectedItem?.dataset.lupsValue,
      selectedBorderStyle: selectedStyle.borderStyle,
      selectedBorderWidth: selectedStyle.borderWidth,
      focusOutlineStyle: selectedFocusStyle.outlineStyle,
      focusOutlineWidth: selectedFocusStyle.outlineWidth,
      tickVisible: !selectedItem?.querySelector('[data-lups-tick]')?.hidden,
      minimumTarget: {
        width: Math.min(...menuItems.map((item) => item.getBoundingClientRect().width)),
        height: Math.min(...menuItems.map((item) => item.getBoundingClientRect().height))
      },
      clippedOptionTextCount: optionText.filter((item) => item.scrollWidth > item.clientWidth + 1).length,
      menu: { x: menuBox.x, y: menuBox.y, width: menuBox.width, height: menuBox.height },
      selectedBox: { x: selectedBox.x, y: selectedBox.y, width: selectedBox.width, height: selectedBox.height },
      annotations
    };
  });
  expect(evidence).toMatchObject({
    forcedColorsActive: true,
    mode: 'auto-asc',
    dataState: 'ready',
    selected: 'auto-asc',
    selectedBorderStyle: 'solid',
    tickVisible: true,
    clippedOptionTextCount: 0
  });
  expect(Number.parseFloat(evidence.selectedBorderWidth)).toBeGreaterThanOrEqual(2);
  expect(Number.parseFloat(evidence.focusOutlineWidth)).toBeGreaterThanOrEqual(3);
  expect(evidence.focusOutlineStyle).not.toBe('none');
  expect(evidence.minimumTarget.width).toBeGreaterThanOrEqual(44);
  expect(evidence.minimumTarget.height).toBeGreaterThanOrEqual(44);
  expect(evidence.menu.x).toBeGreaterThanOrEqual(0);
  expect(evidence.menu.x + evidence.menu.width).toBeLessThanOrEqual(391);
  expect(evidence.annotations.retailer?.borderStyle).toBe('solid');
  expect(evidence.annotations.calculated?.borderStyle).toBe('solid');
  expect(evidence.annotations.unknown).toBeNull();
  const visibleAnnotations = [evidence.annotations.retailer, evidence.annotations.calculated];
  expect(new Set(visibleAnnotations.map((style) => style?.color)).size).toBe(1);
  expect(new Set(visibleAnnotations.map((style) => style?.backgroundColor)).size).toBe(1);
  await page.screenshot({
    path: path.join(outputDirectory, 'forced-colors-active-menu.png'),
    fullPage: false
  });
  await fs.writeFile(
    path.join(outputDirectory, 'forced-colors.json'),
    `${JSON.stringify(evidence, null, 2)}\n`
  );
  await page.emulateMedia({ forcedColors: 'none' });
  return evidence;
}

export function expectControlStateMatrix(evidence) {
  expect(evidence).toHaveLength(CONTROL_VIEWPORTS.length * 9);
  expect(evidence.every((item) => item.geometry.control.x >= 0
    && item.geometry.control.x + item.geometry.control.width <= item.viewport.width + 1)).toBe(true);
  expect(evidence.every((item) => JSON.stringify(item.optionValues) === JSON.stringify(EXPECTED_VALUES)
    && item.statusRoleCount === 1
    && item.annotationOutOfBoundsCount === 0)).toBe(true);
  expect(evidence.filter((item) => item.dataState === 'ready').every((item) => item.annotationCount > 0)).toBe(true);
  expect(evidence.filter((item) => item.dataState === 'ready').every((item) => {
    const annotations = item.computedStyles.annotations;
    const visibleAnnotations = [annotations.retailer, annotations.calculated];
    return annotations.retailer && annotations.calculated && !annotations.unknown
      && new Set(visibleAnnotations.map((style) => style.backgroundColor)).size === 1
      && new Set(visibleAnnotations.map((style) => style.color)).size === 1;
  })).toBe(true);

  const restoredClosedStates = evidence.filter((item) => item.state === 'restored-closed');
  expect(restoredClosedStates.every((item) => item.restored === 'true'
    && item.geometry.status === null && item.geometry.reverse === null
    && item.geometry.trigger?.height >= 48)).toBe(true);
  const tooltipStates = evidence.filter((item) => item.state === 'restored-tooltip');
  expect(tooltipStates.every((item) => item.restored === 'true'
    && item.geometry.status !== null && item.geometry.reverse === null
    && item.geometry.status.x >= 0
    && item.geometry.status.x + item.geometry.status.width <= item.viewport.width + 1)).toBe(true);
  const filteredRestoreStates = evidence.filter((item) => item.state === 'restored-filtered');
  expect(filteredRestoreStates).toHaveLength(CONTROL_VIEWPORTS.length);
  expect(filteredRestoreStates.every((item) => item.restored === 'true'
    && item.dataState === 'ready'
    && item.statusText === 'Website order · 8 loaded products · 1 sponsored/ad tile hidden'
    && item.announcementText === 'Website order · 8 loaded products · 1 sponsored/ad tile hidden'
    && item.geometry.status !== null
    && item.geometry.reverse === null
    && item.geometry.status.x >= 0
    && item.geometry.status.x + item.geometry.status.width <= item.viewport.width + 1)).toBe(true);

  const openStates = evidence.filter((item) => item.state.endsWith('menu-open'));
  expect(openStates.every((item) => item.geometry.menu.x >= 0
    && item.geometry.menu.x + item.geometry.menu.width <= item.viewport.width + 1
    && item.geometry.menu.y >= 0
    && item.geometry.trigger.y - (item.geometry.menu.y + item.geometry.menu.height) >= 7
    && item.geometry.trigger.y - (item.geometry.menu.y + item.geometry.menu.height) <= 13
    && item.menuItemMinimumSize?.width >= 44
    && item.menuItemMinimumSize?.height >= 44
    && item.geometry.defaultAction?.height >= 44
    && item.clippedOptionTextCount === 0
    && item.geometry.status === null)).toBe(true);

  const activeStates = evidence.filter((item) => item.state.startsWith('automatic-'));
  expect(activeStates.every((item) => item.restored === 'false'
    && item.statusText.includes('Loaded range')
    && !item.statusText.includes('Automatic chose')
    && item.announcementText.includes('Automatic chose'))).toBe(true);
  expect(activeStates.filter((item) => item.state.includes('ascending'))
    .every((item) => item.mode === 'auto-asc' && item.buttonText.includes('Low → high'))).toBe(true);
  expect(activeStates.filter((item) => item.state.includes('descending'))
    .every((item) => item.mode === 'auto-desc' && item.buttonText.includes('High → low'))).toBe(true);

  expect(activeStates.filter((item) => item.state === 'automatic-ascending')
    .every((item) => item.geometry.status !== null)).toBe(true);
  const phoneActiveStates = activeStates.filter((item) => item.viewport.width <= 390
    && item.geometry.status !== null);
  expect(phoneActiveStates.every((item) => item.geometry.status.height <= (item.viewport.width === 320 ? 79 : 63)
    && item.geometry.status.x >= 0
    && item.geometry.status.x + item.geometry.status.width <= item.viewport.width + 1
    && item.geometry.status.y >= 0
    && item.geometry.status.y + item.geometry.status.height <= item.viewport.height + 1
    && item.geometry.reverse.height >= 44)).toBe(true);
  expect(openStates.filter((item) => item.viewport.width <= 390)
    .every((item) => !item.overflowCueVisible)).toBe(true);

  const pendingStates = evidence.filter((item) => item.state === 'pending-automatic-ascending');
  expect(pendingStates).toHaveLength(CONTROL_VIEWPORTS.length);
  expect(pendingStates.every((item) => item.dataState === 'pending'
    && item.restored === 'false' && item.mode === 'auto-asc'
    && item.buttonText === 'Auto · $/kg · Low → high'
    && item.statusText === 'Waiting for current-page product data · Website order preserved · 8 loaded products · 1 sponsored/ad tile hidden'
    && item.announcementText === item.statusText
    && item.annotationCount === 0 && item.inlineOrderCount === 0
    && item.geometry.reverse?.height >= 44 && item.geometry.status !== null
    && item.geometry.status.x >= 0
    && item.geometry.status.x + item.geometry.status.width <= item.viewport.width + 1)).toBe(true);
  expect(pendingStates.filter((item) => item.viewport.width <= 390)
    .every((item) => item.geometry.status.height <= 110)).toBe(true);

  const noMatchStates = evidence.filter((item) => item.state === 'no-match-automatic-ascending');
  expect(noMatchStates).toHaveLength(CONTROL_VIEWPORTS.length);
  expect(noMatchStates.every((item) => item.dataState === 'no-match'
    && item.restored === 'false' && item.mode === 'auto-asc'
    && item.buttonText === 'Auto · $/kg · Low → high'
    && item.statusText === 'No matching product data in these loaded results · Website order preserved · 8 loaded products · 1 sponsored/ad tile hidden'
    && item.announcementText === item.statusText
    && item.annotationCount === 0 && item.inlineOrderCount === 0
    && item.geometry.reverse?.height >= 44 && item.geometry.status !== null
    && item.geometry.status.x >= 0
    && item.geometry.status.x + item.geometry.status.width <= item.viewport.width + 1
    && item.geometry.status.y + item.geometry.status.height <= item.viewport.height + 1)).toBe(true);
  expect(noMatchStates.filter((item) => item.viewport.width === 320)
    .every((item) => item.geometry.status.height <= 126)).toBe(true);
}
