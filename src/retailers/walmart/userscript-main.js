/*!
 * Canonical Walmart entry. Capture, annotation, and sorting share one IIFE so
 * their trusted card-model WeakMap stays in a lexical closure that page code
 * cannot replace through globals, attributes, or forged events.
 */
import './api-capture-main.js';
import './content.js';
import './sort-main.js';
