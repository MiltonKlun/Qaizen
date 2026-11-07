# Pagar con tarjeta guardada (STORY-105)

## Descripción

Un cliente con una tarjeta guardada puede pagar el pedido sin volver a
escribir los datos de la tarjeta.

## Criterios de aceptación

1. Dado un cliente con una tarjeta guardada, cuando pulsa "Pagar" en el resumen del pedido, entonces el pago se procesa sin volver a pedir los datos de la tarjeta.
2. Dada una tarjeta guardada vencida, cuando el cliente pulsa "Pagar", entonces se muestra el mensaje "La tarjeta ha vencido." y no se realiza ningún cargo.
