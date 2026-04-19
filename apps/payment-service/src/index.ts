import { getPaymentServiceId } from './config/runtime';
import { startPaymentService } from './payment-service';

startPaymentService().catch((error) => {
  console.error(`[${getPaymentServiceId()}] fatal`, error);
  process.exit(1);
});
