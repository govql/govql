/*instrumentation.js*/
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const headers = process.env.OTEL_EXPORTER_OTLP_HEADERS;
const url = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: resourceFromAttributes ({
    [ATTR_SERVICE_NAME]: 'govql-server'
  }),
  traceExporter: new OTLPTraceExporter({
    url: url,
    headers: headers,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();


