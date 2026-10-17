#pragma once

#include <Windows.h>
#include "SDK.hpp"

using namespace SDK;

namespace Networking {
	extern UNetDriver* NetDriver;

	void InitChannelTracking();

	bool Listen(UEngine* Engine, int Port);

	void TickNetworking();

	uint32_t ConnectionState(UNetConnection* Connection);
}
