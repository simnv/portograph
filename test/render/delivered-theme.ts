// The delivered default theme sheet that test/render/theme.test.ts compares `themeCss()` against, unchanged.

export const DELIVERED_THEME_CSS = `/* portograph — network profile default theme. Paint only: colour, fill, dash, opacity.
   Geometry (stroke-width, fonts, radii) is locked by the renderer and stated after this sheet. */
.pg-canvas{fill:#f2f2f3}
.group-box{fill:#eef6ff;fill-opacity:0.55;stroke:#94bce3;stroke-dasharray:none}
.group-label{fill:#416180}
.node-body{fill:#ffffff;stroke:#749dc4}
.node-label{fill:#1d1f20}
.node-description{fill:#5d5d60;fill-opacity:1}
.icon-tile{fill:#749dc4;stroke:#416180}
.node-icon{fill:none;stroke:#ffffff;stroke-linecap:round;stroke-linejoin:round}
.pill{fill:#d6ebff;stroke:#749dc4}
.pill-label{fill:#2c455d}
.link-line{fill:none;stroke:#2c455d}
.link-label{fill:#5d5d60}
.multiplicity-label{fill:#416180}
.legend-label{fill:#424244}
.overlay-line{stroke:#7b7fc4;stroke-opacity:0.6}
.overlay-endpoint{fill:#7b7fc4;stroke:none}
.icon-tile.provider{fill:#7f8aa9;stroke:#4c5573}
.node-icon.provider{stroke:#ffffff}
.pill.provider{fill:#dfe3f0;stroke:#7f8aa9}
.pill-label.provider{fill:#353c55}
.icon-tile.router{fill:#4f9aa6;stroke:#2f6670}
.node-icon.router{stroke:#ffffff}
.pill.router{fill:#cfe9ec;stroke:#4f9aa6}
.pill-label.router{fill:#20484f}
.icon-tile.tbr{fill:#7b7fc4;stroke:#4d5190}
.node-icon.tbr{stroke:#ffffff}
.pill.tbr{fill:#e0e1f6;stroke:#7b7fc4}
.pill-label.tbr{fill:#363966}
.icon-tile.rr{fill:#9a9184;stroke:#625b50}
.node-icon.rr{stroke:#ffffff}
.pill.rr{fill:#e8e4dc;stroke:#9a9184}
.pill-label.rr{fill:#46413a}
.link-line.dotted{stroke:#2f6670;stroke-dasharray:1 3;stroke-linecap:round}
.link-line.dashed{stroke:#4d5190;stroke-dasharray:4 4}
.pill.uplink{fill:#94bce3}
.pill-label.uplink{fill:#2c455d}
.pill.downlink{fill:#d6ebff}
.pill-label.downlink{fill:#2c455d}
.pill.peer{fill:#c4c6ea}
.pill-label.peer{fill:#363966}
.pill.mgmt{fill:#d3cdc1}
.pill-label.mgmt{fill:#46413a}
.pill.lag{fill:#a9d6db}
.pill-label.lag{fill:#20484f}
.pill.loopback{fill:none;stroke:#94bce3}
.pill.up{stroke:#2c455d}
.pill.down{stroke:#597ea3;stroke-dasharray:2 2}
.pill.admin-down{stroke:#98989b;stroke-dasharray:2 2;fill:#e7e7ea}
.pill-label.admin-down{fill:#7a7a7d}
.pill.degraded{stroke:#1d1f20}
.port.unused{opacity:0.45}
@media (prefers-color-scheme: dark){
  .pg-canvas{fill:#1d2d3d}
  .group-box{fill:#2c455d;fill-opacity:0.55;stroke:#597ea3;stroke-dasharray:none}
  .group-label{fill:#b5d9fd}
  .node-body{fill:#1d2d3d;stroke:#94bce3}
  .node-label{fill:#eef6ff}
  .node-description{fill:#b5d9fd;fill-opacity:1}
  .icon-tile{fill:#749dc4;stroke:#b5d9fd}
  .node-icon{fill:none;stroke:#ffffff;stroke-linecap:round;stroke-linejoin:round}
  .pill{fill:#2c455d;stroke:#94bce3}
  .pill-label{fill:#d6ebff}
  .link-line{fill:none;stroke:#b5d9fd}
  .link-label{fill:#b5d9fd}
  .multiplicity-label{fill:#d6ebff}
  .legend-label{fill:#d6ebff}
  .overlay-line{stroke:#a2a5d9;stroke-opacity:0.6}
  .overlay-endpoint{fill:#a2a5d9;stroke:none}
  .icon-tile.provider{fill:#7f8aa9;stroke:#c3cadf}
  .node-icon.provider{stroke:#ffffff}
  .pill.provider{fill:#353c55;stroke:#a3adc7}
  .pill-label.provider{fill:#dfe3f0}
  .icon-tile.router{fill:#4f9aa6;stroke:#a9d6db}
  .node-icon.router{stroke:#ffffff}
  .pill.router{fill:#20484f;stroke:#7dbcc4}
  .pill-label.router{fill:#cfe9ec}
  .icon-tile.tbr{fill:#7b7fc4;stroke:#c4c6ea}
  .node-icon.tbr{stroke:#ffffff}
  .pill.tbr{fill:#363966;stroke:#a2a5d9}
  .pill-label.tbr{fill:#e0e1f6}
  .icon-tile.rr{fill:#9a9184;stroke:#d3cdc1}
  .node-icon.rr{stroke:#ffffff}
  .pill.rr{fill:#46413a;stroke:#b8b0a2}
  .pill-label.rr{fill:#e8e4dc}
  .link-line.dotted{stroke:#7dbcc4;stroke-dasharray:1 3;stroke-linecap:round}
  .link-line.dashed{stroke:#a2a5d9;stroke-dasharray:4 4}
  .pill.uplink{fill:#416180}
  .pill-label.uplink{fill:#eef6ff}
  .pill.downlink{fill:#416180}
  .pill-label.downlink{fill:#eef6ff}
  .pill.peer{fill:#416180}
  .pill-label.peer{fill:#eef6ff}
  .pill.mgmt{fill:#416180}
  .pill-label.mgmt{fill:#eef6ff}
  .pill.lag{fill:#416180}
  .pill-label.lag{fill:#eef6ff}
  .pill.loopback{fill:none;stroke:#749dc4}
  .pill.up{stroke:#d6ebff}
  .pill.down{stroke:#94bce3;stroke-dasharray:2 2}
  .pill.admin-down{stroke:#749dc4;stroke-dasharray:2 2;fill:#1d2d3d}
  .pill-label.admin-down{fill:#94bce3}
  .pill.degraded{stroke:#ffffff}
  .port.unused{opacity:0.45}
}
@media print{
  .pg-canvas{fill:#ffffff}
  .group-box{fill:none;fill-opacity:1;stroke:#98989b;stroke-dasharray:none}
  .group-label{fill:#5d5d60}
  .node-body{fill:#ffffff;stroke:#424244}
  .node-label{fill:#000000}
  .node-description{fill:#5d5d60;fill-opacity:1}
  .icon-tile{fill:#7a7a7d;stroke:#2b2b2d}
  .node-icon{fill:none;stroke:#ffffff;stroke-linecap:round;stroke-linejoin:round}
  .pill{fill:#f5f5f8;stroke:#7a7a7d}
  .pill-label{fill:#000000}
  .link-line{fill:none;stroke:#000000}
  .link-label{fill:#5d5d60}
  .multiplicity-label{fill:#000000}
  .legend-label{fill:#000000}
  .overlay-line{stroke:#7a7a7d;stroke-opacity:0.7}
  .overlay-endpoint{fill:#7a7a7d;stroke:none}
  .icon-tile.provider{fill:#d4d4d7;stroke:#2b2b2d}
  .node-icon.provider{stroke:#2b2b2d}
  .icon-tile.router{fill:#5d5d60;stroke:#2b2b2d}
  .node-icon.router{stroke:#ffffff}
  .icon-tile.tbr{fill:#98989b;stroke:#2b2b2d}
  .node-icon.tbr{stroke:#ffffff}
  .icon-tile.rr{fill:#2b2b2d;stroke:#2b2b2d}
  .node-icon.rr{stroke:#ffffff}
  .link-line.dotted{stroke:#5d5d60;stroke-dasharray:1 3;stroke-linecap:round}
  .link-line.dashed{stroke:#5d5d60;stroke-dasharray:4 4}
  .pill.uplink{fill:#b7b7ba}
  .pill.downlink{fill:#e7e7ea}
  .pill.peer{fill:#d4d4d7}
  .pill.mgmt{fill:#f5f5f8}
  .pill.lag{fill:#d4d4d7}
  .pill.loopback{fill:none;stroke:#98989b}
  .pill.up{stroke:#000000}
  .pill.down{stroke:#5d5d60;stroke-dasharray:2 2}
  .pill.admin-down{stroke:#7a7a7d;stroke-dasharray:2 2;fill:#ffffff}
  .pill-label.admin-down{fill:#7a7a7d}
  .pill.degraded{stroke:#000000}
  .port.unused{opacity:0.45}
}`;
