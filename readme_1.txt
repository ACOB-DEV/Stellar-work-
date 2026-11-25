Still to do
now
StellarWork is an open-source decentralized freelance marketplace on Stellar. Payments are held in Soroban escrow and released by state transitions, not platform custody logic.

Repository Layout
stellarwork
├── contracts/escrow
├── contracts/retainer
├── frontend
└── docs
Local DevNet (Isolated Testing)
For fully isolated contract testing without relying on public testnets, use the devnet scripts:

# 1. Set up a local Soroban devnet (requires Docker)
./scripts/setup-devnet.sh

# 2. Reset the devnet state when needed
./scripts/reset-devnet.sh

# 3. Run tests against the local devnet
./scripts/run-tests-local.sh
The setup script:

Starts a Stellar Quickstart container with a standalone network
Funds a test admin account
Deploys and initializes the escrow contract
Saves configuration to .env.dev
Local Setup
Using Docker Compose (Recommended) ⭐
Spin up the complete development environment with one command:

docker compose up
This starts:

stellar — Local Stellar testnet with Soroban RPC at http://localhost:8000
frontend — Next.js dev server at http://localhost:3000 with hot-reload (files are live-synced)
contract-builder — Rust + Soroban CLI environment for building/testing contracts.
First run? The Stellar testnet takes 20–30 seconds to initialize. Once ready, the frontend automatically connects to it via the Docker internal network.

Common Docker Compose Tasks
# View service status
docker compose ps

# View logs (all services or specific service)
docker compose logs
docker compose logs stellar
docker compose logs frontend

# Build and deploy contracts
docker compose exec contract-builder bash -c "cd contracts/escrow && soroban contract build"

# Run contract tests
docker compose exec contract-builder cargo test --manifest-path contracts/escrow/Cargo.toml

# Run frontend tests
docker compose exec frontend npm run test

# Stop services (preserve state)
docker compose down

# Stop and remove volumes (fresh start next time)
docker compose down -v
For detailed setup/troubleshooting/advanced configuration, see Docker Compose Setup Guide.

Quick Makefile Commands
Common Docker Compose operations are available via Makefile:

make up      # docker compose up
make down    # docker compose down
make logs    # docker compose logs -f
make test-contract   # docker compose exec contract-builder cargo test
make test-frontend   # docker compose exec frontend npm run test
Manual Setup
1) Contract
cd contracts/escrow
cargo test
2) Frontend
cd frontend
cp .env.example .env.local
npm install
npm run dev
Open http://localhost:3000.

3) Pre-commit Hooks (Optional)
To automate quality checks, see the pre-commit setup guide in the contribution docs.

Deploy Contract to Stellar Testnet (Step-by-Step)
This walkthrough takes you from build to frontend integration with copy-pasteable commands.

1) Prerequisites
Install Soroban CLI (docs).
Have a funded Stellar Testnet account.
Configure a Soroban identity:
soroban config identity generate stellarwork-admin
soroban config identity address stellarwork-admin
Add Testnet network (if not already configured):
soroban config network add testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"
2) Build the Escrow Contract
cd contracts/escrow
cargo test
soroban contract build
Expected wasm output:

target/wasm32-unknown-unknown/release/escrow.wasm
3) Deploy to Testnet
cd contracts/escrow
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/escrow.wasm \
  --source stellarwork-admin \
  --network testnet
Save the returned contract ID (for example CC...).

4) Initialize Contract State
initialize(admin, native_token) must be called once.

Determine your admin address:
soroban config identity address stellarwork-admin
Choose a native token contract address on testnet (or your token contract).
Invoke initialize:
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source stellarwork-admin \
  --network testnet \
  -- initialize \
  --admin <ADMIN_ADDRESS> \
  --native_token <NATIVE_TOKEN_CONTRACT_ADDRESS>
5) Configure Frontend Environment
cd frontend
cp .env.example .env.local
Set at minimum:

NEXT_PUBLIC_CONTRACT_ID=<CONTRACT_ID>
NEXT_PUBLIC_NETWORK=testnet
NEXT_PUBLIC_SOROBAN_RPC=https://soroban-testnet.stellar.org
See docs/environments.md for the complete environment variable reference, defaults, and Testnet/Mainnet notes.

Then run:

npm install
npm run dev
Open http://localhost:3000.

6) Verify Deployment
Read methods should return values without requiring a signed transaction:

soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  -- get_job_count
Troubleshooting
HostError: Error(Contract, #...) on write calls: check caller authorization and method preconditions.
NEXT_PUBLIC_CONTRACT_ID is not configured: confirm frontend/.env.local and restart npm run dev.
contract not found / RPC errors: verify --network testnet and correct contract ID.
Initialize appears to do nothing: this contract ignores repeated initialize calls after first setup.
Insufficient balance on deploy/invoke: fund the identity from Stellar Friendbot and retry.
Current Feature Set
Core escrow lifecycle (post_job, accept_job, submit_work, approve_work, cancel_job)
Freelancer-initiated job cancellation with penalty (freelancer_cancel_job)
On-chain job storage and count queries
Multi-token support with admin-managed whitelist (add_allowed_token, remove_allowed_token)
IPFS-based job description storage via web3.storage (with localStorage fallback)
Platform fee accounting (2.5%)
Dispute resolution with flexible client/freelancer splits
Contract upgrade mechanism with 24-hour timelock
Contract unit tests for core paths
Core pages: /, /post-job, /job/[id], /dashboard, /admin, /disputes, /profile/[address]
