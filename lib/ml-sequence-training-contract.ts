export type SequenceDatasetSource =
  | { sourceType: "duration"; sourceDatasetId: string; horizonKey?: string }
  | { sourceType: "unified"; sourceDatasetId: string; horizonKey: string };

export interface SequenceTrainingDatasetRef {
  datasetId: string;
  source: SequenceDatasetSource;
}

export function parseSequenceTrainingDatasetRef(input: unknown): SequenceTrainingDatasetRef {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid sequence training dataset reference");
  }

  const value = input as Record<string, unknown>;
  const datasetId = typeof value.datasetId === "string" ? value.datasetId.trim() : "";
  const source = value.source;

  if (!datasetId || !source || typeof source !== "object") {
    throw new Error("Sequence training dataset reference requires datasetId and source");
  }

  const sourceValue = source as Record<string, unknown>;
  const sourceType = sourceValue.sourceType;
  const sourceDatasetId = typeof sourceValue.sourceDatasetId === "string" ? sourceValue.sourceDatasetId.trim() : "";
  const horizonKey = typeof sourceValue.horizonKey === "string" ? sourceValue.horizonKey.trim() : "";

  if ((sourceType !== "duration" && sourceType !== "unified") || !sourceDatasetId) {
    throw new Error("Invalid sequence training dataset source");
  }

  if (sourceType === "unified" && !horizonKey) {
    throw new Error("Unified sequence training requires an explicit horizonKey");
  }

  return {
    datasetId,
    source:
      sourceType === "unified"
        ? { sourceType, sourceDatasetId, horizonKey }
        : { sourceType, sourceDatasetId, ...(horizonKey ? { horizonKey } : {}) },
  };
}
