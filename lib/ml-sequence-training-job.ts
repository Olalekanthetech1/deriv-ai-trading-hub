import type { SequenceTrainingDatasetRef } from "./ml-sequence-training-contract";

export interface SequenceTrainingJobMetadata {
  datasetRef: SequenceTrainingDatasetRef;
}

export function buildSequenceTrainingMetadata(datasetRef: SequenceTrainingDatasetRef): SequenceTrainingJobMetadata {
  if (datasetRef.source.sourceType === "unified" && !datasetRef.source.horizonKey) {
    throw new Error("Unified sequence training requires an explicit horizonKey");
  }

  return { datasetRef };
}
