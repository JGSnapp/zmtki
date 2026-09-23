import type { Artifact } from '@zmtki/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSource } from '../../../shared/ipc';
import { api } from '../state/store';

interface Props {
  artifact: Artifact;
  selected: boolean;
  visible: boolean;
  onPatch: (props: Record<string, unknown>) => void;
}

const stop = { onPointerDown: (e: React.PointerEvent) => e.stopPropagation() };

/**
 * Captures a window or a screen through Chromium's desktop capture and shows
 * it live. The capture is held only while the card is on screen: an app
 * streamed onto a far corner of the board costs nothing until someone looks.
 *
 * Window ids are only valid while the window lives. After a restart the card
 * looks its window up again by name before giving up on it.
 */
export const AppStreamArtifact = ({ artifact, selected, visible, onPatch }: Props) => {
  const sourceId = typeof artifact.props.sourceId === 'string' ? artifact.props.sourceId : '';
  const title = typeof artifact.props.title === 'string' ? artifact.props.title : '';
  const videoRef = useRef<HTMLVideoElement>(null);
  const [picking, setPicking] = useState(!sourceId);
  const [sources, setSources] = useState<AppSource[] | null>(null);
  const [status, setStatus] = useState<'idle' | 'live' | 'lost' | 'error'>('idle');
  const [error, setError] = useState('');

  const loadSources = useCallback(async () => {
    setSources(null);
    setSources(await api.appStream.sources());
  }, []);

  useEffect(() => {
    if (picking) void loadSources();
  }, [picking, loadSources]);

  useEffect(() => {
    if (!sourceId || picking || !visible) return;
    let stream: MediaStream | null = null;
    let cancelled = false;

    const capture = async (id: string) =>
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          // Chromium's desktop capture constraints; not in the DOM typings.
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: id,
            maxWidth: 2560,
            maxHeight: 1600,
            maxFrameRate: 30,
          },
        } as unknown as MediaTrackConstraints,
      });

    void (async () => {
      try {
        stream = await capture(sourceId);
      } catch {
        // The window id went stale — the app restarted or reopened. Find the
        // same window by its title before declaring it lost.
        const all = await api.appStream.sources().catch(() => []);
        const same = all.find((s) => s.name === title);
        if (same && !cancelled) {
          onPatch({ sourceId: same.id });
          return;
        }
        if (!cancelled) setStatus('lost');
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        void video.play().catch(() => undefined);
      }
      setStatus('live');
      stream.getVideoTracks()[0]?.addEventListener('ended', () => setStatus('lost'));
    })().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    // onPatch identity changes per render; the capture only depends on the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, title, picking, visible]);

  if (picking || !sourceId) {
    return (
      <div className="app-stream">
        <div className="card-title" data-drag-handle="true">
          ▣ Выберите окно или экран
          <span className="card-title-spacer" />
          <button className="chip" {...stop} onClick={() => void loadSources()}>
            Обновить
          </button>
          {sourceId && (
            <button className="chip" {...stop} onClick={() => setPicking(false)}>
              Отмена
            </button>
          )}
        </div>
        <div className="source-grid" onWheel={(e) => selected && e.stopPropagation()}>
          {!sources && <div className="empty-hint">Ищу окна…</div>}
          {sources?.length === 0 && <div className="empty-hint">Нет доступных окон</div>}
          {sources?.map((source) => (
            <button
              key={source.id}
              className="source-tile"
              {...stop}
              onClick={() => {
                onPatch({ sourceId: source.id, title: source.name, kind: source.kind });
                setPicking(false);
                setStatus('idle');
              }}
            >
              {source.thumbnail ? <img src={source.thumbnail} alt="" /> : <div className="source-blank" />}
              <span className="source-name">
                {source.icon && <img className="source-icon" src={source.icon} alt="" />}
                {source.kind === 'screen' ? '🖥 ' : ''}
                {source.name}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="app-stream">
      <div className="card-title" data-drag-handle="true">
        <span className={'live-dot' + (status === 'live' ? ' is-live' : '')} />
        <span className="stream-title">{title || 'Окно'}</span>
        <span className="card-title-spacer" />
        {sourceId.startsWith('window:') && (
          <button className="chip" title="Переключиться в это приложение" {...stop} onClick={() => void api.appStream.focus(sourceId)}>
            Перейти к окну
          </button>
        )}
        <button className="chip" {...stop} onClick={() => setPicking(true)}>
          Сменить
        </button>
      </div>
      <div className="stream-body">
        <video ref={videoRef} className="stream-video" muted playsInline />
        {status === 'idle' && <div className="browser-loading">Подключаюсь к «{title}»…</div>}
        {status === 'lost' && (
          <div className="browser-loading">
            Окно «{title}» закрыто или недоступно.
            <button className="btn" {...stop} onClick={() => setPicking(true)}>
              Выбрать другое
            </button>
          </div>
        )}
        {status === 'error' && <div className="browser-loading browser-error">Захват не удался: {error}</div>}
      </div>
    </div>
  );
};
