/**
 * portograph — YAML in, a laid-out diagram (SVG) out.
 *
 * Headless core (ADR-0004): no DOM, no framework. The pipeline
 * `parse → layout → render` lands here ticket by ticket; the layout JSON is a
 * first-class output that `score` and the tests consume.
 */

export { VERBS, EXIT, COMMAND_DEADLINE_MS, isVerb, helpText, parseCommand, sidecarPaths, formatDiagnostic, UsageError } from './cli.js';
export type { Command, Verb } from './cli.js';
export { layout, createBudget, CommandDeadlineError, UNBOUNDED_BUDGET } from './pipeline/index.js';
export type { Budget, LayoutOptions, LayoutProgress } from './pipeline/index.js';
export * from './model/index.js';
export * from './text/index.js';
export * from './geometry/index.js';
export * from './parse/index.js';
export * from './migrate/index.js';
export * from './score/index.js';
export { CANVAS_MARGIN, DEFAULT_STROKE_WIDTHS } from './theme/geometry.js';
export { LEGEND_GEOMETRY } from './theme/legend.js';
export { LEGEND_DEFAULT_CLASS, NETWORK_LINK_CLASSES, NETWORK_NODE_CLASSES, NETWORK_PORT_LOOPBACK, NETWORK_PORT_ROLES,
  NETWORK_PORT_STATUS, NETWORK_THEME, classDisplayLabel, classOrder, linkClassStyle, nodeClassPaint, nodeClassStyle,
  portRolePaint, portRoleStyle } from './profiles/network/theme.js';
export type { FullRamp, HueRamp, LinkClassStyle, Modal, NodeClassStyle, PillPaint, PortRoleStyle, PortStatusStyle, Ramp, ThemeMode,
  ThemePaint }
  from './profiles/network/theme.js';
export { render, linkVisible, OVERLAY_ENDPOINT_RADIUS } from './render/index.js';
export type { RenderOptions } from './render/index.js';
export { drawio } from './render/drawio.js';
export type { DrawioOptions } from './render/drawio.js';
export * from './resolve/index.js';
export * from './layout/sides-one.js';
export * from './layout/size.js';
export * from './theme/content.js';
export * from './profiles/network/icons.js';
export { skeleton, SkeletonError } from './layout/skeleton.js';
export type { SkeletonOptions } from './layout/skeleton.js';
export { createWorkerElkAttempt, createBrowserElkFactory, runElkAttempt, elkDeadlineMs, ElkDeadlineError } from './layout/elk-worker.js';
export type { ElkAttempt, CreateElkAttempt, ElkWorker, ElkClock } from './layout/elk-worker.js';
export { sidesTwo } from './layout/sides-two.js';
export { rebuildNodeGeometry } from './layout/node-geometry.js';
export { freezePortTopology, restoreLayoutModel, restoreFinalLayout, withLayoutMutation, FINAL_STAGES } from './layout/mutation.js';
export type { PlacementRule } from './layout/mutation.js';
export { rows } from './layout/rows.js';
export { rebuildRowPaths, expectedRowPath, straightCorridorClear, facingPair, rowPathCandidate, STRAIGHT_PATH_CLEARANCE } from './layout/row-paths.js';
export type { FacingPair } from './layout/row-paths.js';

export { lanes, allocateLanes, rebuildLaneExtents, laneWidth, validateLanes } from './layout/lanes.js';
export { flanks, alignFlanks, rebuildFlankPaths, flankPair, flankPathCandidate, expectedFlankPath } from './layout/flanks.js';
export { centre, centreDraft, createCentreBudget, selectAnchorTier } from './layout/centre.js';
export type { CentreBudget } from './layout/centre.js';
export { rebuildRegions } from './layout/regions.js';
export { rebuildRegionGeometry } from './layout/region-rebuild.js';
export { bars, shapeBars, rebuildBarDrops, barLink, BAR_PADDING } from './layout/bars.js';
export { bundles, prepareBundleGeometry, rebuildBundlePaths, BundleFeasibilityError } from './layout/bundles.js';
export { bands, GROUP_LABEL_GEOMETRY } from './layout/bands.js';
export { linkLabels, produceLinkLabels, validateLinkLabels, overlayDensity, overlayLabelsSuppressed,
  LINK_LABEL_GEOMETRY, LINK_LABEL_CODES, OVERLAY_LABEL_DENSITY } from './layout/link-labels.js';
export { diagramBounds, drawnBoxes, legendBoxes, legendRequired, legendVariants, paintedSwatch, portRoles, produceLegend } from './layout/legend.js';

export { optimizeBundleOrder } from './layout/bundle-order.js';
export type { BundleOrderResult } from './layout/bundle-order.js';

export { route, routeRemainders } from './route/index.js';
export type { RouteOptions } from './route/index.js';
export { batchRequest, planRoute, routeObstacles, nodeClearance, trimChain, stemCheckpoint, TERMINAL_TRIM,
  ROUTE_PARAMETERS, SHAPE_BUFFER_DISTANCE } from './route/index.js';
export type { LinkPlan, RoutePiece, RoutePlan, RouteObstacle } from './route/index.js';
export { checkpointsHonoured, crossedTiers, overlayPath, simplify, stitchPath, stitchPaths, stubCandidate,
  reservationConflicts, reservedRuns, validateRoutedPaths } from './route/index.js';
export type { ReservationConflict, RoutedLinkPath } from './route/index.js';
export { createBrowserRouteFactory, createRouteFactory, RouteDeadlineError, RouteSession, withRouteSession,
  systemRouteClock, ROUTE_BUDGET_MS, ROUTE_REQUEST, ROUTE_RESPONSE, ALL_DIRECTIONS, DIRECTION_BITS } from './route/index.js';
export type { CreateRouteAttempt, RouteAssets, RouteAttempt, RouteBatch, RouteCheckpoint, RouteClock,
  RouteConnector, RouteEndpoint, RoutePin, RouteShape, RouteWorker, RoutedConnector } from './route/index.js';
