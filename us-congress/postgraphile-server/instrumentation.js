/*instrumentation.js*/
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const headers = process.env.OTEL_EXPORTER_OTLP_HEADERS;
const url = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: url,
    headers: headers,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();


