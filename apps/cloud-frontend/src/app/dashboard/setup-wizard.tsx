/**
 * Setup wizard — shown when no companies are connected yet.
 * Guides the user through the initial setup steps.
 */
import DownloadButton from '../../components/download-button'

const steps = [
    {
        number: 1,
        title: 'Download the Connector',
        description:
            'Install the TallyBridge Connector app on the machine running Tally. It communicates between Tally and this cloud dashboard.',
        hasDownload: true,
    },
    {
        number: 2,
        title: 'Connect to Tally',
        description:
            'Open the connector app and enter your Tally server URL (e.g., http://192.168.1.10:9000). The connector will scan for open companies.',
        hasDownload: false,
    },
    {
        number: 3,
        title: 'Configure ERPNext',
        description:
            'Enter your ERPNext site URL, API key, and API secret in the connector. It will test the connection and set up required custom fields automatically.',
        hasDownload: false,
    },
    {
        number: 4,
        title: 'Register with Cloud',
        description:
            'The connector registers with this cloud platform, creating the company profile and establishing secure communication.',
        hasDownload: false,
    },
    {
        number: 5,
        title: 'Start Syncing',
        description:
            'Once registered, the connector automatically syncs vouchers, ledgers, and stock items. You can monitor everything from this dashboard.',
        hasDownload: false,
    },
]

export default function SetupWizard() {
    return (
        <div className="max-w-3xl mx-auto">
            <div className="text-center mb-10">
                <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Welcome to TallyBridge</h1>
                <p className="mt-3 text-lg text-gray-500">
                    No companies are connected yet. Follow these steps to get started.
                </p>
            </div>

            <div className="space-y-0">
                {steps.map((step, idx) => (
                    <div key={step.number} className="flex gap-4">
                        {/* Timeline */}
                        <div className="flex flex-col items-center">
                            <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-sm shrink-0">
                                {step.number}
                            </div>
                            {idx < steps.length - 1 && <div className="w-0.5 flex-1 bg-blue-200 my-1" />}
                        </div>

                        {/* Content */}
                        <div className={`pb-8 ${idx === steps.length - 1 ? 'pb-0' : ''}`}>
                            <h3 className="font-semibold text-gray-900 text-lg">{step.title}</h3>
                            <p className="mt-1 text-sm text-gray-500 leading-relaxed">{step.description}</p>
                            {step.hasDownload && (
                                <div className="mt-3">
                                    <DownloadButton variant="primary" />
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            <div className="mt-10 p-5 bg-blue-50 border border-blue-200 rounded-xl">
                <h4 className="font-semibold text-blue-800 text-sm">Waiting for connector...</h4>
                <p className="mt-1 text-sm text-blue-600">
                    This page will automatically update when a connector registers. The dashboard will appear once your
                    first company is connected.
                </p>
                <div className="mt-3 flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    <span className="text-xs text-blue-500 font-medium">Listening for connections...</span>
                </div>
            </div>
        </div>
    )
}
