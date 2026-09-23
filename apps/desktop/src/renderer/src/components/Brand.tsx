import { useState } from 'react';

/**
 * The zmtki wordmark. The artwork lives in `apps/desktop/resources/logo.png`
 * (served as the renderer's public directory); until it is there, a typeset
 * wordmark in the same colours stands in, so a missing file is never a broken
 * image in the toolbar.
 */
export const Logo = ({ className }: { className?: string }) => {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className={'brand-wordmark ' + (className ?? '')}>zmtki</span>;
  }
  return (
    <img
      className={'brand-logo ' + (className ?? '')}
      src="./logo.png"
      alt="zmtki"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
};
