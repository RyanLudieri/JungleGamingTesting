# Validação

Execução local em 12/11/2026, Windows com Docker Desktop/WSL2, Bun 1.4.4, PostgreSQL 16.11 e LocalStack 4.12.0.

| Verificação | Resultado |
|---|---|
| `bun run typecheck` | Sem erros |
| `bun test` | 49 testes, 207 assertions, zero falhas |
| `bun run test:integration` | 47 testes, 233 assertions, zero falhas |
| `bun run demo` | Duas apostas concorrentes: 200/422; replay idempotente; REFUND via SQS; diferença de reconciliação 0.00 |
| `bun run test:recovery` | SQS e PostgreSQL interrompidos e restaurados; liveness 200, readiness 503 durante falha; eventos publicados após recuperação; replay e ledger consistentes |
| Docker Compose | API, 3 consumidores, 2 publishers, worker de referências e dependências iniciados |

Os resultados não constituem benchmark de throughput nem homologação de produção. Autenticação real, dashboard, tracing, backups operacionais e teste de carga não fazem parte desta entrega. As limitações de durabilidade do emulador local, ordenação de eventos e custo de reconciliação no commit estão documentadas em `ARCHITECTURE.md`.
