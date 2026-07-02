import type {
  MetricAggregation,
  MetricDefinition,
  MetricsDocument,
  MeasurementRecord,
  TopologyDocument,
  UnknownValuesMode,
  ValidationIssue
} from "./types";

const EPSILON = 1e-6;

export interface TopologyNode {
  id: string;
  levelIndex: number;
  levelName: string;
  parent?: string;
  children: string[];
  standalone: boolean;
}

export interface TopologyGraph {
  levels: string[];
  unknownValues: UnknownValuesMode;
  nodes: Map<string, TopologyNode>;
  roots: string[];
}

export interface MetricState {
  components: Record<string, number>;
}

export interface ProjectedMeasurement extends MeasurementRecord {
  topology_level: string;
  topology_level_index: number;
  source: "observed" | "derived" | "rogue";
}

export interface TopologyResolution {
  projected: ProjectedMeasurement[];
  warnings: ValidationIssue[];
}

type DerivationResult =
  | { status: "derived"; state: MetricState }
  | { status: "ambiguous"; reason: string }
  | { status: "invalid"; reason: string };

interface MetricAggregator {
  kind: MetricAggregation;
  requiresWeight: boolean;
  observe(value: number, weight: number | undefined, metric: MetricDefinition, metricId: string): MetricState;
  combine(states: MetricState[]): MetricState;
  tryDeriveMissingChild(parent: MetricState, knownChildren: MetricState[]): DerivationResult;
  display(state: MetricState): number;
  equals(left: MetricState, right: MetricState): boolean;
  validate(state: MetricState): string | undefined;
}

interface ObservedMetricGroup {
  metricId: string;
  stat: string;
  runId: string;
  states: Map<string, MetricState>;
  observedIds: Set<string>;
  rogueIds: string[];
  ignoredIds: string[];
}

function issue(severity: "error" | "warning", message: string, file?: string, path?: string): ValidationIssue {
  return { severity, message, file, path };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function finiteNumber(value: number, description: string): number {
  invariant(Number.isFinite(value), `${description} must be a finite number.`);
  return value;
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function state(keys: string[], values: number[]): MetricState {
  const components: Record<string, number> = {};
  keys.forEach((key, index) => {
    components[key] = finiteNumber(values[index], `Component "${key}"`);
  });
  return { components };
}

function sumComponent(states: MetricState[], key: string): number {
  return states.reduce((total, item) => total + item.components[key], 0);
}

function subtractComponents(parent: MetricState, knownChildren: MetricState[], keys: string[]): MetricState {
  return state(
    keys,
    keys.map((key) => parent.components[key] - sumComponent(knownChildren, key))
  );
}

abstract class ComponentAggregator implements MetricAggregator {
  abstract kind: MetricAggregation;
  abstract requiresWeight: boolean;
  protected abstract keys: string[];

  abstract observe(value: number, weight: number | undefined, metric: MetricDefinition, metricId: string): MetricState;
  abstract combine(states: MetricState[]): MetricState;
  abstract display(metricState: MetricState): number;

  tryDeriveMissingChild(parent: MetricState, knownChildren: MetricState[]): DerivationResult {
    const derived = subtractComponents(parent, knownChildren, this.keys);
    const error = this.validate(derived);
    if (error) {
      return { status: "invalid", reason: error };
    }
    return { status: "derived", state: derived };
  }

  equals(left: MetricState, right: MetricState): boolean {
    return this.keys.every((key) => close(left.components[key], right.components[key]));
  }

  validate(stateToCheck: MetricState): string | undefined {
    for (const key of this.keys) {
      if (!Number.isFinite(stateToCheck.components[key])) {
        return `component "${key}" is not finite`;
      }
    }
    return undefined;
  }
}

class SumAggregator extends ComponentAggregator {
  kind: MetricAggregation = "sum";
  requiresWeight = false;
  protected keys = ["total"];

  observe(value: number): MetricState {
    return state(this.keys, [finiteNumber(value, "sum value")]);
  }

  combine(states: MetricState[]): MetricState {
    return state(this.keys, [sumComponent(states, "total")]);
  }

  display(metricState: MetricState): number {
    return metricState.components.total;
  }
}

class MaxAggregator implements MetricAggregator {
  kind: MetricAggregation = "max";
  requiresWeight = false;

  observe(value: number): MetricState {
    return state(["max"], [finiteNumber(value, "max value")]);
  }

  combine(states: MetricState[]): MetricState {
    return state(["max"], [Math.max(...states.map((item) => item.components.max))]);
  }

  tryDeriveMissingChild(parent: MetricState, knownChildren: MetricState[]): DerivationResult {
    const parentValue = parent.components.max;
    if (knownChildren.length === 0) {
      return { status: "derived", state: state(["max"], [parentValue]) };
    }

    const knownMax = Math.max(...knownChildren.map((item) => item.components.max));
    if (knownMax > parentValue + EPSILON) {
      return { status: "invalid", reason: `known child max ${knownMax} is greater than parent max ${parentValue}` };
    }
    if (close(knownMax, parentValue)) {
      return {
        status: "ambiguous",
        reason: `a known child already equals parent max ${parentValue}`
      };
    }
    return { status: "derived", state: state(["max"], [parentValue]) };
  }

  display(metricState: MetricState): number {
    return metricState.components.max;
  }

  equals(left: MetricState, right: MetricState): boolean {
    return close(left.components.max, right.components.max);
  }

  validate(metricState: MetricState): string | undefined {
    return Number.isFinite(metricState.components.max) ? undefined : "max is not finite";
  }
}

class WeightedAggregator extends ComponentAggregator {
  requiresWeight = true;
  protected keys = ["weightedTotal", "weight"];

  constructor(
    public readonly kind: "average" | "ratio" | "percentage",
    private readonly inputScale: number,
    private readonly outputScale: number
  ) {
    super();
  }

  observe(value: number, weight: number | undefined, metric: MetricDefinition, metricId: string): MetricState {
    invariant(metric.weight, `Metric "${metricId}" uses aggregation "${this.kind}" and must define a weight.`);
    invariant(weight !== undefined, `Metric "${metricId}" needs weight "${metric.weight}".`);

    const checkedValue = finiteNumber(value, `Metric "${metricId}" value`);
    const checkedWeight = finiteNumber(weight, `Weight "${metric.weight}"`);

    if (this.kind === "ratio") {
      invariant(checkedValue >= -EPSILON && checkedValue <= 1 + EPSILON, `Metric "${metricId}" ratio must be between 0 and 1.`);
    }
    if (this.kind === "percentage") {
      invariant(checkedValue >= -EPSILON && checkedValue <= 100 + EPSILON, `Metric "${metricId}" percentage must be between 0 and 100.`);
    }

    const observed = state(this.keys, [checkedValue * this.inputScale * checkedWeight, checkedWeight]);
    const error = this.validate(observed);
    invariant(!error, `Invalid observation for metric "${metricId}": ${error}.`);
    return observed;
  }

  combine(states: MetricState[]): MetricState {
    return state(this.keys, [sumComponent(states, "weightedTotal"), sumComponent(states, "weight")]);
  }

  display(metricState: MetricState): number {
    const weight = metricState.components.weight;
    invariant(Math.abs(weight) > EPSILON, `Cannot display ${this.kind} with zero weight.`);
    return (metricState.components.weightedTotal / weight) * this.outputScale;
  }

  validate(metricState: MetricState): string | undefined {
    const baseError = super.validate(metricState);
    if (baseError) {
      return baseError;
    }

    const weight = metricState.components.weight;
    const weightedTotal = metricState.components.weightedTotal;
    if (weight <= EPSILON) {
      return "weight must be greater than zero";
    }

    if ((this.kind === "ratio" || this.kind === "percentage") && (weightedTotal < -EPSILON || weightedTotal > weight + EPSILON)) {
      return `weighted total ${weightedTotal} must be between 0 and weight ${weight}`;
    }

    return undefined;
  }
}

const aggregators = new Map<MetricAggregation, MetricAggregator>();

export function registerMetricAggregator(aggregator: MetricAggregator): void {
  aggregators.set(aggregator.kind, aggregator);
}

function getAggregator(kind: MetricAggregation): MetricAggregator {
  const aggregator = aggregators.get(kind);
  invariant(aggregator, `Unknown aggregation "${kind}".`);
  return aggregator;
}

registerMetricAggregator(new SumAggregator());
registerMetricAggregator(new MaxAggregator());
registerMetricAggregator(new WeightedAggregator("average", 1, 1));
registerMetricAggregator(new WeightedAggregator("ratio", 1, 1));
registerMetricAggregator(new WeightedAggregator("percentage", 0.01, 100));

export function validateMetricsDocument(metrics: MetricsDocument): string[] {
  const errors: string[] = [];
  const metricIds = new Set(Object.keys(metrics.metrics));

  if (!metrics.metrics.cpu) {
    errors.push('metrics.yaml must define required metric "cpu" for regression.');
  } else if (metrics.metrics.cpu.aggregation !== "sum") {
    errors.push('metrics.yaml metric "cpu" must use aggregation "sum" for regression CPU totals.');
  }

  for (const [metricId, definition] of Object.entries(metrics.metrics)) {
    const aggregator = getAggregator(definition.aggregation);
    if (aggregator.requiresWeight && !definition.weight) {
      errors.push(`Metric "${metricId}" uses aggregation "${definition.aggregation}" and must define weight.`);
    }
    if (!aggregator.requiresWeight && definition.weight) {
      errors.push(`Metric "${metricId}" defines weight, but aggregation "${definition.aggregation}" does not use one.`);
    }
    if (definition.weight && !metricIds.has(definition.weight)) {
      errors.push(`Metric "${metricId}" references unknown weight metric "${definition.weight}".`);
    }
  }

  return errors;
}

export function buildTopologyGraph(topology: TopologyDocument): TopologyGraph {
  invariant(topology && typeof topology === "object", "topology.yaml must define a document.");
  invariant(Array.isArray(topology.levels), "topology.yaml must define a levels array.");
  invariant(topology.levels.length > 0, "topology.yaml must define at least one level.");
  invariant(
    topology.topology && typeof topology.topology === "object" && !Array.isArray(topology.topology),
    "topology.yaml must define a topology map."
  );
  invariant(
    topology.standalone && typeof topology.standalone === "object" && !Array.isArray(topology.standalone),
    "topology.yaml must define a standalone map."
  );
  invariant(new Set(topology.levels).size === topology.levels.length, "Topology level names must be unique.");

  const graph: TopologyGraph = {
    levels: topology.levels,
    unknownValues: topology.unknownValues,
    nodes: new Map<string, TopologyNode>(),
    roots: []
  };

  for (const [levelName, parentMap] of Object.entries(topology.topology)) {
    invariant(
      parentMap && typeof parentMap === "object" && !Array.isArray(parentMap),
      `topology.${levelName} must define a parent map.`
    );
    const levelIndex = topology.levels.indexOf(levelName);
    invariant(levelIndex >= 0, `Topology references unknown level "${levelName}".`);
    invariant(levelIndex < topology.levels.length - 1, `Level "${levelName}" is the last level and cannot define children.`);

    for (const [parentId, children] of Object.entries(parentMap)) {
      const parent = ensureNode(graph, parentId, levelIndex, `topology.${levelName}.${parentId}`);
      invariant(Array.isArray(children), `topology.${levelName}.${parentId} must list child ids as an array.`);
      invariant(new Set(children).size === children.length, `Parent "${parentId}" lists the same child more than once.`);

      for (const childId of children) {
        invariant(childId !== parentId, `Node "${parentId}" cannot be its own child.`);
        const child = ensureNode(graph, childId, levelIndex + 1, `child "${childId}" of "${parentId}"`);
        invariant(!child.parent || child.parent === parentId, `Node "${childId}" belongs to both "${child.parent}" and "${parentId}".`);
        child.parent = parentId;
        if (!parent.children.includes(childId)) {
          parent.children.push(childId);
        }
      }
    }
  }

  for (const [levelName, nodes] of Object.entries(topology.standalone)) {
    const levelIndex = topology.levels.indexOf(levelName);
    invariant(levelIndex >= 0, `Standalone references unknown level "${levelName}".`);
    invariant(Array.isArray(nodes), `standalone.${levelName} must list node ids as an array.`);
    invariant(new Set(nodes).size === nodes.length, `Standalone level "${levelName}" lists the same node more than once.`);

    for (const nodeId of nodes) {
      const node = ensureNode(graph, nodeId, levelIndex, `standalone.${levelName}`);
      invariant(!node.parent && node.children.length === 0, `Standalone node "${nodeId}" must not have topology relations.`);
      node.standalone = true;
    }
  }

  graph.roots = [...graph.nodes.values()].filter((node) => !node.parent).map((node) => node.id);
  return graph;
}

function ensureNode(graph: TopologyGraph, id: string, levelIndex: number, source: string): TopologyNode {
  invariant(id.trim().length > 0, `${source} contains an empty node id.`);

  const existing = graph.nodes.get(id);
  if (existing) {
    invariant(
      existing.levelIndex === levelIndex,
      `Node "${id}" is declared at both level "${existing.levelName}" and level "${graph.levels[levelIndex]}".`
    );
    return existing;
  }

  const node: TopologyNode = {
    id,
    levelIndex,
    levelName: graph.levels[levelIndex],
    children: [],
    standalone: false
  };
  graph.nodes.set(id, node);
  return node;
}

export function resolveTopologyMeasurements(
  topology: TopologyDocument,
  metrics: MetricsDocument,
  measurements: MeasurementRecord[],
  metricFilter?: string,
  statFilter?: string,
  levelFilter?: string
): TopologyResolution {
  const graph = buildTopologyGraph(topology);
  const warnings: ValidationIssue[] = [];
  const projected: ProjectedMeasurement[] = [];
  const grouped = new Map<string, MeasurementRecord[]>();

  for (const measurement of measurements) {
    if (!measurement.instance_id) continue;
    if (metricFilter && measurement.metric_id !== metricFilter) continue;
    if (statFilter && measurement.stat !== statFilter) continue;
    if (!metrics.metrics[measurement.metric_id]) continue;

    const key = [measurement.run_id, measurement.metric_id, measurement.stat].join("|");
    grouped.set(key, [...(grouped.get(key) ?? []), measurement]);
  }

  for (const groupMeasurements of grouped.values()) {
    const first = groupMeasurements[0];
    const metric = metrics.metrics[first.metric_id];
    const observed = buildObservedMetricGroup(graph, metrics, measurements, groupMeasurements, metric, first.metric_id);
    for (const ignoredId of observed.ignoredIds) {
      warnings.push(
        issue(
          "warning",
          `Ignoring unknown topology node "${ignoredId}" for ${first.metric_id}/${first.stat} in run "${first.run_id}".`,
          "measurements.csv"
        )
      );
    }

    const resolved = resolveOneMetric(graph, first.metric_id, metric, observed);
    const levels = levelFilter ? graph.levels.filter((level) => level === levelFilter) : graph.levels;

    for (const levelName of levels) {
      const levelIndex = graph.levels.indexOf(levelName);
      invariant(levelIndex >= 0, `Unknown topology projection level "${levelName}".`);
      const ids = [
        ...graph.roots.flatMap((rootId) => projectNode(graph, resolved, rootId, levelIndex)),
        ...observed.rogueIds
      ];
      const seen = new Set<string>();

      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const stateForNode = resolved.get(id);
        if (!stateForNode) continue;

        projected.push({
          run_id: first.run_id,
          metric_id: first.metric_id,
          stat: first.stat,
          instance_id: id,
          value: getAggregator(metric.aggregation).display(stateForNode),
          topology_level: levelName,
          topology_level_index: levelIndex,
          source: observed.rogueIds.includes(id) ? "rogue" : observed.observedIds.has(id) ? "observed" : "derived"
        });
      }
    }
  }

  return { projected, warnings };
}

function buildObservedMetricGroup(
  graph: TopologyGraph,
  metrics: MetricsDocument,
  allMeasurements: MeasurementRecord[],
  groupMeasurements: MeasurementRecord[],
  metric: MetricDefinition,
  metricId: string
): ObservedMetricGroup {
  const aggregator = getAggregator(metric.aggregation);
  const states = new Map<string, MetricState>();
  const observedIds = new Set<string>();
  const rogueIds: string[] = [];
  const ignoredIds: string[] = [];

  for (const measurement of groupMeasurements) {
    const isKnown = graph.nodes.has(measurement.instance_id);
    if (!isKnown && graph.unknownValues === "strict") {
      throw new Error(`measurements.csv contains unknown topology node "${measurement.instance_id}", but topology unknownValues mode is strict.`);
    }
    if (!isKnown && graph.unknownValues === "ignore") {
      if (!ignoredIds.includes(measurement.instance_id)) {
        ignoredIds.push(measurement.instance_id);
      }
      continue;
    }

    const weight = readWeight(allMeasurements, measurement, metric, aggregator.requiresWeight);
    const metricState = aggregator.observe(measurement.value, weight, metric, metricId);
    states.set(measurement.instance_id, metricState);
    observedIds.add(measurement.instance_id);
    if (!isKnown && !rogueIds.includes(measurement.instance_id)) {
      rogueIds.push(measurement.instance_id);
    }
  }

  return {
    metricId,
    stat: groupMeasurements[0].stat,
    runId: groupMeasurements[0].run_id,
    states,
    observedIds,
    rogueIds,
    ignoredIds
  };
}

function readWeight(
  measurements: MeasurementRecord[],
  measurement: MeasurementRecord,
  metric: MetricDefinition,
  required: boolean
): number | undefined {
  if (!required) {
    return undefined;
  }

  invariant(metric.weight, `Metric "${measurement.metric_id}" requires a weight field.`);
  const weight = measurements.find(
    (candidate) =>
      candidate.run_id === measurement.run_id &&
      candidate.metric_id === metric.weight &&
      candidate.stat === measurement.stat &&
      candidate.instance_id === measurement.instance_id
  );
  invariant(
    weight,
    `Metric "${measurement.metric_id}" for "${measurement.instance_id}" in run "${measurement.run_id}" needs weight "${metric.weight}" with stat "${measurement.stat}".`
  );
  return weight.value;
}

function resolveOneMetric(
  graph: TopologyGraph,
  metricId: string,
  metric: MetricDefinition,
  observed: ObservedMetricGroup
): Map<string, MetricState> {
  const aggregator = getAggregator(metric.aggregation);
  const states = new Map<string, MetricState>();

  for (const [id, metricState] of observed.states.entries()) {
    if (graph.nodes.has(id)) {
      states.set(id, metricState);
    }
  }

  const descending = [...graph.nodes.values()].sort((left, right) => right.levelIndex - left.levelIndex);
  const ascending = [...graph.nodes.values()].sort((left, right) => left.levelIndex - right.levelIndex);

  let changed = true;
  let iteration = 0;
  while (changed) {
    invariant(iteration <= graph.nodes.size + 1, `Metric "${metricId}" did not converge while resolving topology.`);
    changed = false;
    iteration += 1;

    for (const node of descending) {
      if (node.children.length === 0) continue;

      const childStates = childStatesFor(node, states);
      if (childStates.length !== node.children.length) continue;

      const derived = aggregator.combine(childStates);
      const existing = states.get(node.id);
      if (existing) {
        assertCompatible(metricId, metric, node, existing, derived);
      } else {
        states.set(node.id, derived);
        changed = true;
      }
    }

    for (const node of ascending) {
      const parentState = states.get(node.id);
      if (!parentState || node.children.length === 0) continue;

      const missingChildren = node.children.filter((childId) => !states.has(childId));
      if (missingChildren.length !== 1 || missingChildren.length === node.children.length) continue;

      const knownChildren = node.children.filter((childId) => states.has(childId)).map((childId) => states.get(childId));
      invariant(knownChildren.every(Boolean), `Internal error while resolving children for "${node.id}".`);

      const result = aggregator.tryDeriveMissingChild(parentState, knownChildren as MetricState[]);
      if (result.status === "invalid") {
        throw new Error(`Metric "${metricId}" cannot derive missing child "${missingChildren[0]}" under "${node.id}": ${result.reason}.`);
      }
      if (result.status === "derived") {
        states.set(missingChildren[0], result.state);
        changed = true;
      }
    }
  }

  validateResolvedMetric(graph, metricId, metric, states);

  for (const [id, metricState] of observed.states.entries()) {
    if (!graph.nodes.has(id)) {
      states.set(id, metricState);
    }
  }

  return states;
}

function validateResolvedMetric(
  graph: TopologyGraph,
  metricId: string,
  metric: MetricDefinition,
  states: Map<string, MetricState>
): void {
  const aggregator = getAggregator(metric.aggregation);
  const subtreeMemo = new Map<string, boolean>();
  const errors: string[] = [];

  const subtreeHasState = (nodeId: string): boolean => {
    const cached = subtreeMemo.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }

    const node = graph.nodes.get(nodeId);
    invariant(node, `Unknown topology node "${nodeId}".`);
    const hasState = states.has(nodeId) || node.children.some((childId) => subtreeHasState(childId));
    subtreeMemo.set(nodeId, hasState);
    return hasState;
  };

  for (const node of graph.nodes.values()) {
    if (node.children.length === 0) continue;

    const parentState = states.get(node.id);
    const missingChildren = node.children.filter((childId) => !states.has(childId));
    const knownChildren = node.children.filter((childId) => states.has(childId)).map((childId) => states.get(childId) as MetricState);

    if (missingChildren.length === 0) {
      const derived = aggregator.combine(knownChildren);
      if (parentState) {
        try {
          assertCompatible(metricId, metric, node, parentState, derived);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      continue;
    }

    const branchHasData = Boolean(parentState) || node.children.some((childId) => subtreeHasState(childId));
    if (!branchHasData) continue;

    if (parentState && knownChildren.length === 0) {
      continue;
    }

    if (!parentState) {
      errors.push(`Metric "${metricId}" cannot resolve "${node.id}": missing child value(s) ${formatIds(missingChildren)} and no parent observation is available.`);
      continue;
    }

    if (missingChildren.length > 1) {
      errors.push(`Metric "${metricId}" cannot derive children ${formatIds(missingChildren)} under "${node.id}": more than one child is unknown.`);
      continue;
    }

    const result = aggregator.tryDeriveMissingChild(parentState, knownChildren);
    if (result.status === "ambiguous" || result.status === "invalid") {
      errors.push(`Metric "${metricId}" cannot derive missing child "${missingChildren[0]}" under "${node.id}": ${result.reason}.`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function assertCompatible(
  metricId: string,
  metric: MetricDefinition,
  node: TopologyNode,
  observed: MetricState,
  derived: MetricState
): void {
  const aggregator = getAggregator(metric.aggregation);
  const validationError = aggregator.validate(derived);
  invariant(!validationError, `Metric "${metricId}" has invalid derived value for "${node.id}": ${validationError}.`);

  if (!aggregator.equals(observed, derived)) {
    throw new Error(
      `Metric "${metricId}" observation for "${node.id}" conflicts with its children: observed ${formatComponents(
        observed
      )}, derived ${formatComponents(derived)}.`
    );
  }
}

function childStatesFor(node: TopologyNode, states: Map<string, MetricState>): MetricState[] {
  return node.children.map((childId) => states.get(childId)).filter((item): item is MetricState => Boolean(item));
}

function projectNode(graph: TopologyGraph, states: Map<string, MetricState>, nodeId: string, targetLevelIndex: number): string[] {
  const node = graph.nodes.get(nodeId);
  if (!node) {
    return [];
  }

  if (node.levelIndex >= targetLevelIndex || node.children.length === 0) {
    return [node.id];
  }

  const childIdsWithState = node.children.filter((childId) => subtreeHasResolvedState(graph, states, childId));
  if (childIdsWithState.length === 0 && states.has(node.id)) {
    return [node.id];
  }

  return childIdsWithState.flatMap((childId) => projectNode(graph, states, childId, targetLevelIndex));
}

function subtreeHasResolvedState(graph: TopologyGraph, states: Map<string, MetricState>, nodeId: string): boolean {
  const node = graph.nodes.get(nodeId);
  if (!node) {
    return false;
  }

  return states.has(nodeId) || node.children.some((childId) => subtreeHasResolvedState(graph, states, childId));
}

function formatComponents(metricState: MetricState): string {
  return JSON.stringify(metricState.components);
}

function formatIds(ids: string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
}
