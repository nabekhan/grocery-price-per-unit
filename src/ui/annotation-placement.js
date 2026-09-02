/*!
 * Shared product-image placement for unit-price annotations.
 *
 * Retailer product cards use different wrapper depths and frequently rename
 * generated classes. Their semantic image markers are considerably more
 * stable, so every adapter resolves one of those markers and mounts the badge
 * inside the actual image surface. The CSS then uses that surface as the
 * containing block for one consistent bottom-right overlay.
 */

const IMAGE_SELECTORS = [
  '[data-testid="product-image"]',
  '[data-testid^="productCardImage_"][data-testid$="-testId"]',
  'img[data-testid="productTileImage"]',
  '[data-automation-id="productTileImage"]',
  'img[data-automation-id="productTileImage"]'
];

/**
 * Resolve the element that visually owns the product image.
 *
 * Walmart exposes its stable marker on the <img> itself. Absolutely positioned
 * children cannot be mounted inside a replaced element, so in that case the
 * immediate parent is the image surface. Loblaw and Save-On expose their marker
 * on an ordinary wrapper and can be used directly.
 */
export function findProductImageHost(host) {
  if (!host?.querySelector) return null;

  let marker = null;
  for (const selector of IMAGE_SELECTORS) {
    marker = host.querySelector(selector);
    if (marker) break;
  }
  if (!marker) return null;

  const imageHost = marker.matches?.('img') ? marker.parentElement : marker;
  if (!imageHost || imageHost === host || !host.contains(imageHost)) return null;
  return imageHost;
}

/**
 * Place or re-home a badge without recreating it. Retailer SPAs recycle card
 * nodes, so this runs on every annotation pass and repairs placement when the
 * image wrapper changes. If a verified image marker is absent, the badge stays
 * on the card as a safe fallback instead of guessing from generated classes.
 */
export function placeAnnotationOnProductImage(host, note) {
  if (!host || !note) return null;

  const imageHost = findProductImageHost(host);
  const previousHost = note.parentElement;
  if (imageHost) {
    if (previousHost !== imageHost) imageHost.append(note);
    if (previousHost !== imageHost) previousHost?.removeAttribute('data-lups-image-host');
    imageHost.setAttribute('data-lups-image-host', '');
    note.dataset.lupsPlacement = 'image-overlay';
    return imageHost;
  }

  previousHost?.removeAttribute('data-lups-image-host');
  if (note.parentElement !== host || note !== host.lastElementChild) host.append(note);
  note.dataset.lupsPlacement = 'fallback';
  return null;
}

/**
 * Preserve the annotation's accessible price/provenance when a retailer marks
 * its image surface aria-hidden. ARIA hiding is inherited and cannot be undone
 * on the badge itself, so a single visually-hidden note is mirrored at the card
 * level. The visible badge keeps its native hover tooltip in either case.
 */
export function syncAnnotationAccessibility(host, note) {
  if (!host || !note) return null;
  let accessibleNote = host.querySelector('[data-lups-annotation-accessible]');
  const hiddenWithImage = Boolean(note.closest('[aria-hidden="true"]'));
  if (!hiddenWithImage) {
    accessibleNote?.remove();
    return null;
  }

  if (!accessibleNote) {
    accessibleNote = document.createElement('span');
    accessibleNote.setAttribute('data-lups-annotation-accessible', '');
    accessibleNote.setAttribute('role', 'note');
    accessibleNote.className = 'lups-visually-hidden';
    host.append(accessibleNote);
  }
  accessibleNote.textContent = note.getAttribute('aria-label') || note.textContent;
  return accessibleNote;
}

/** Remove every DOM artifact owned by one card annotation. */
export function clearAnnotation(host) {
  if (!host?.querySelector) return;
  const note = host.querySelector('[data-lups-annotation]');
  note?.parentElement?.removeAttribute('data-lups-image-host');
  note?.remove();
  host.querySelector('[data-lups-annotation-accessible]')?.remove();
}
