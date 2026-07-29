import type { JSX as ReactJSX } from 'react';

/**
 * React 19 dropped the global JSX namespace in favour of React.JSX. Re-exposing
 * it globally keeps `JSX.Element` return annotations working across the app.
 */
declare global {
  namespace JSX {
    type Element = ReactJSX.Element;
    type ElementType = ReactJSX.ElementType;
    type ElementClass = ReactJSX.ElementClass;
    type IntrinsicElements = ReactJSX.IntrinsicElements;
    type ElementAttributesProperty = ReactJSX.ElementAttributesProperty;
    type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute;
  }
}

export {};
