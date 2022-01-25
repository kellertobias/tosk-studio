import React from 'react';

import { ConnectionToast } from './connection-toast';

export const DeskGUI: React.FC = () => (
	<div className="desk-body">
		<div className="desk">
			<div className="frame">
				{/* <Modal />
				<SettingsView />
				<MacrosView />
				<TimeView />
				<StateView />
				<RateView />
				<OBSView />
				<AudioView /> */}
				<ConnectionToast />
			</div>
		</div>
	</div>
);
