import type { JSX } from 'react';
import type { MapArtifactSpec, MusicArtifactSpec, VideoArtifactSpec } from './specTypes.js';
import { registerArtifact } from './registry.js';

function Empty({ text }: { text: string }): JSX.Element {
  return <div className="art-empty">{text}</div>;
}

function mapEmbedUrl(spec: MapArtifactSpec): string {
  if (spec.embedUrl.trim()) return spec.embedUrl.trim();
  const { lat, lng, zoom } = spec;
  const delta = Math.max(0.002, 0.18 / Math.pow(2, Math.max(0, zoom - 10)));
  const left = lng - delta;
  const right = lng + delta;
  const top = lat + delta * 0.7;
  const bottom = lat - delta * 0.7;
  const bbox = `${left}%2C${bottom}%2C${right}%2C${top}`;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lng}`;
}

function youtubeId(url: string): string | null {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/);
  return m?.[1] ?? null;
}

function vimeoId(url: string): string | null {
  const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return m?.[1] ?? null;
}

registerArtifact<MapArtifactSpec>('map', ({ spec, detailed }) => {
  if (!detailed) {
    return <Empty text={spec.label || `${spec.lat.toFixed(3)}, ${spec.lng.toFixed(3)}`} />;
  }
  return (
    <div className="art-media art-map">
      {(spec.label || spec.title) && <div className="art-media-cap">{spec.label || spec.title}</div>}
      <iframe
        className="art-media-frame nodrag nowheel"
        title={spec.title || 'map'}
        src={mapEmbedUrl(spec)}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  );
});

registerArtifact<MusicArtifactSpec>('music', ({ spec, detailed }) => {
  if (!detailed) {
    return <Empty text={[spec.artist, spec.track || spec.title].filter(Boolean).join(' — ') || 'музыка'} />;
  }
  return (
    <div className="art-media art-music">
      {spec.coverUrl ? (
        <img className="art-music-cover nodrag" src={spec.coverUrl} alt="" />
      ) : (
        <div className="art-music-cover placeholder">♪</div>
      )}
      <div className="art-music-meta">
        <div className="art-music-track">{spec.track || spec.title || 'Трек'}</div>
        {spec.artist && <div className="art-music-artist">{spec.artist}</div>}
        {spec.url ? (
          <audio className="art-media-audio nodrag nowheel" controls src={spec.url} preload="metadata" />
        ) : (
          <div className="art-empty">нет url</div>
        )}
      </div>
    </div>
  );
});

registerArtifact<VideoArtifactSpec>('video', ({ spec, detailed }) => {
  if (!detailed) return <Empty text={spec.title || spec.url || 'видео'} />;
  const yt = youtubeId(spec.url);
  const vim = vimeoId(spec.url);
  return (
    <div className="art-media art-video">
      {yt ? (
        <iframe
          className="art-media-frame nodrag nowheel"
          title={spec.title || 'youtube'}
          src={`https://www.youtube.com/embed/${yt}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      ) : vim ? (
        <iframe
          className="art-media-frame nodrag nowheel"
          title={spec.title || 'vimeo'}
          src={`https://player.vimeo.com/video/${vim}`}
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
        />
      ) : spec.url ? (
        <video
          className="art-media-video nodrag nowheel"
          controls
          src={spec.url}
          poster={spec.poster || undefined}
          preload="metadata"
        />
      ) : (
        <div className="art-empty">нет url</div>
      )}
    </div>
  );
});
