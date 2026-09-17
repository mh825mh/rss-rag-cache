import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "retentionDays",
    "select",
    {
      displayName: "Retention Period",
      subtitle: "How long to keep cached RSS entries in the local database.",
      options: [
        { value: "30", displayName: "30 Days" },
        { value: "60", displayName: "60 Days" },
        { value: "90", displayName: "90 Days" },
        { value: "365", displayName: "365 Days" },
      ],
    },
    "90",
  )
  .field(
    "refreshIntervalHours",
    "numeric",
    {
      displayName: "Refresh Interval (Hours)",
      subtitle: "How often to automatically fetch new RSS items.",
      min: 1,
      max: 168,
      int: true,
      slider: { step: 1, min: 1, max: 24 },
    },
    6,
  )
  .field(
    "embeddingModel",
    "select",
    {
      displayName: "Embedding Model",
      subtitle: "The embedding model loaded in LM Studio server.",
      options: [
        { value: "nomic-embed-text-v1.5", displayName: "nomic-embed-text-v1.5" },
        { value: "text-embedding-nomic-embed-text-v1.0", displayName: "text-embedding-nomic-embed-text-v1.0" },
        { value: "bge-large-en-v1.5", displayName: "bge-large-en-v1.5" },
        { value: "all-MiniLM-L6-v2", displayName: "all-MiniLM-L6-v2" }
      ],
    },
    "nomic-embed-text-v1.5",
  )
  .build();