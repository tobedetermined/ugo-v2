/**
 * kml.js — KML export and import for UGO recordings.
 *
 * Export produces a KML file with:
 *   - A 3D LineString path (eye positions) matching the in-app visualisation
 *   - A gx:Tour for animated playback in Google Earth
 *   - ExtendedData embedding the original JSON for lossless round-trip import
 *
 * Import extracts the embedded JSON. Files without it (e.g. from third parties)
 * are rejected with a clear error message.
 */

function exportKML(recording) {
  const name = recording.name || 'UGO Recording';

  // ── Curtain segments ──────────────────────────────────────────────────────
  // Each segment is an extruded LineString: extrude drops the line to the
  // ground forming a filled curtain wall. tessellate is required for the
  // fill to render. The combined style covers both the top edge (LineStyle)
  // and the curtain fill (PolyStyle).
  const curtainPlacemarks = recording.segments.map((segment, i) => {
    const coords = segment.map(f => `${f.eye.lng},${f.eye.lat},${f.eye.altitude}`).join('\n          ');
    return `    <Placemark>
      <name>UGO Path${recording.segments.length > 1 ? ' ' + (i + 1) : ''}</name>
      <styleUrl>#ugo-curtain</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>
          ${coords}
        </coordinates>
      </LineString>
    </Placemark>`;
  });

  // ── gx:Tour ───────────────────────────────────────────────────────────────
  // Each frame becomes a LookAt-based FlyTo. Duration is the actual time delta
  // to the next frame so playback mirrors the original recording speed.
  const flyTos = [];
  for (const segment of recording.segments) {
    for (let i = 0; i < segment.length; i++) {
      const frame    = segment[i];
      const next     = segment[i + 1];
      const deltaSec = next
        ? Math.max(0.05, (next.timestamp - frame.timestamp) / 1000)
        : recording.sampleIntervalMs / 1000;

      flyTos.push(
        `        <gx:FlyTo>
          <gx:duration>${deltaSec.toFixed(3)}</gx:duration>
          <gx:flyToMode>smooth</gx:flyToMode>
          <LookAt>
            <longitude>${frame.center.lng}</longitude>
            <latitude>${frame.center.lat}</latitude>
            <altitude>${frame.center.altitude}</altitude>
            <heading>${frame.heading}</heading>
            <tilt>${frame.tilt}</tilt>
            <range>${frame.range}</range>
            <altitudeMode>relativeToGround</altitudeMode>
          </LookAt>
        </gx:FlyTo>`
      );
    }
  }

  // ── Embedded JSON (lossless round-trip) ───────────────────────────────────
  const json = JSON.stringify(recording).replace(/]]>/g, ']]]]><![CDATA[>');

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"
     xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${_escapeXml(name)}</name>
    <description>User Generated Orbit — recorded with UGO (usergeneratedorbit.com)</description>
    <LookAt>
      <longitude>${((recording.metadata.boundingBox.east + recording.metadata.boundingBox.west) / 2).toFixed(6)}</longitude>
      <latitude>${((recording.metadata.boundingBox.north + recording.metadata.boundingBox.south) / 2).toFixed(6)}</latitude>
      <altitude>0</altitude>
      <heading>0</heading>
      <tilt>45</tilt>
      <range>${Math.max(recording.metadata.boundingBox.north - recording.metadata.boundingBox.south, recording.metadata.boundingBox.east - recording.metadata.boundingBox.west) * 111320 * 2}</range>
      <altitudeMode>relativeToGround</altitudeMode>
    </LookAt>

    <Style id="ugo-curtain">
      <LineStyle>
        <color>ff2020ff</color>
        <width>2</width>
      </LineStyle>
      <PolyStyle>
        <color>381e1eff</color>
      </PolyStyle>
    </Style>

${curtainPlacemarks.join('\n')}

    <gx:Tour>
      <name>${_escapeXml(name)}</name>
      <gx:Playlist>
${flyTos.join('\n')}
      </gx:Playlist>
    </gx:Tour>

    <ExtendedData>
      <Data name="ugo-recording">
        <value><![CDATA[${json}]]></value>
      </Data>
    </ExtendedData>

  </Document>
</kml>`;

  return kml;
}

function importKML(kmlText) {
  const doc = new DOMParser().parseFromString(kmlText, 'application/xml');

  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid KML file');
  }

  for (const node of doc.querySelectorAll('ExtendedData Data')) {
    if (node.getAttribute('name') === 'ugo-recording') {
      const value = node.querySelector('value');
      if (value) {
        try {
          return JSON.parse(value.textContent.trim());
        } catch {
          throw new Error('Embedded UGO data is corrupt');
        }
      }
    }
  }

  throw new Error('This KML was not exported from UGO and cannot be loaded');
}

function downloadKML(recording) {
  const kml  = exportKML(recording);
  const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = _safeFilename(recording.name || 'ugo-recording') + '.kml';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function _escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _safeFilename(str) {
  return String(str).replace(/[^a-z0-9_\-. ]/gi, '_');
}

// Export for test environments (no-op in browser)
if (typeof exports !== 'undefined') {
  exports.exportKML = exportKML;
  exports.importKML = importKML;
}
