const axios = require('axios');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');

async function getToken(username, password, domainName) {
    const endpoint = 'https://iam.tr-west-1.myhuaweicloud.com/v3/auth/tokens';
    const requestBody = {
        auth: {
            identity: {
                methods: ['password'],
                password: {
                    user: {
                        name: username,
                        password: password,
                        domain: {
                            name: domainName
                        }
                    }
                }
            },
            scope: {
                project: {
                    name: process.env.REGION
                }
            }
        }
    };

    try {
        const response = await axios.post(endpoint, requestBody, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        return response.headers['x-subject-token'];
    } catch (error) {
        console.error('Failed to obtain token:', error);
        throw new Error('Token could not be obtained.');
    }
}

function getFormattedTimes() {
    const now = new Date();
    const offset = 3 * 60 * 60 * 1000; // UTC+3

    const start_time = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    start_time.setUTCHours(0, 0, 0, 0);
    start_time.setTime(start_time.getTime() - offset);

    const end_time = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    end_time.setUTCHours(23, 59, 0, 0);
    end_time.setTime(end_time.getTime() - offset);

    return {
        formattedStartTime: start_time.toISOString().replace(".000Z", "Z"),
        formattedEndTime: end_time.toISOString().replace(".000Z", "Z"),
        endTimeForFileName: end_time.toISOString().split('T')[0]
    };
}

async function fetchBackupLogs(token, startTime, endTime) {
    const projectId = process.env.PROJECT_ID
    const region = process.env.REGION
    const apiUrl = `https://cbr.${region}.myhuaweicloud.com/v3/${projectId}/operation-logs`;

    try {
        const response = await axios.get(apiUrl, {
            headers: {
                "Content-Type": "application/json",
                "X-Auth-Token": token,
            },
            params: {
                start_time: startTime,
                end_time: endTime,
            },
        });

        return response.data.operation_logs
            .filter(log => log.operation_type !== "delete")
            .map(log => {
                const started = new Date(log.started_at);
                started.setHours(started.getHours() + 3);

                const ended = log.ended_at ? new Date(log.ended_at) : null;
                if (ended) {
                    ended.setHours(ended.getHours() + 3);
                }

                return {
                    TaskID: log.extra_info?.common?.task_id || log.id,
                    BackupID: log.extra_info?.backup?.backup_id,
                    TaskType: log.operation_type,
                    Status: log.status,
                    ResourceID: log.extra_info?.resource?.id,
                    ResourceName: log.extra_info?.resource?.name,
                    ResourceType: log.extra_info?.resource?.type,
                    VaultID: log.vault_id,
                    VaultName: log.vault_name,
                    Started: started.toISOString().replace(".000Z", ""),
                    Ended: ended ? ended.toISOString().replace(".000Z", "") : null,
                };
            });
    } catch (error) {
        console.error('Failed to fetch logs:', error);
        throw new Error('Log fetch failed.');
    }
}

async function createFormattedExcel(logs, filePath) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('CBR Logs');

    worksheet.columns = [
        { header: "TaskID", key: "TaskID", width: 20 },
        { header: "BackupID", key: "BackupID", width: 20 },
        { header: "TaskType", key: "TaskType", width: 15 },
        { header: "Status", key: "Status", width: 15 },
        { header: "ResourceID", key: "ResourceID", width: 20 },
        { header: "ResourceName", key: "ResourceName", width: 20 },
        { header: "ResourceType", key: "ResourceType", width: 20 },
        { header: "VaultID", key: "VaultID", width: 20 },
        { header: "VaultName", key: "VaultName", width: 20 },
        { header: "Started", key: "Started", width: 20 },
        { header: "Ended", key: "Ended", width: 20 },
    ];

    worksheet.getRow(1).eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4F81BD' },
        };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    logs.forEach(log => {
        worksheet.addRow(log);
    });

    worksheet.columns.forEach(column => {
        if (column.key === 'Started' || column.key === 'Ended') {
            column.style = { numFmt: 'yyyy-mm-dd hh:mm:ss' };
        }
    });

    await workbook.xlsx.writeFile(filePath);
}

async function sendEmailWithReport(filePath, fileName, recipients) {
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: {
            user: 'fburakbakir@gmail.com',
            pass: process.env.SMTP_PASS,
        },
    });

    const mailOptions = {
        from: 'fburakbakir@gmail.com',
        to: recipients.join(','),
        subject: fileName,
        text: `Please review the attached daily CBR report for ${fileName}`,
        attachments: [
            {
                filename: fileName,
                path: filePath,
            }
        ],
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('Email successfully sent:', info.response);
        return 'Email successfully sent';
    } catch (error) {
        console.error('Failed to send email:', error.message);
        throw new Error('Email send failed');
    }
}

exports.handler = async function (event, context, callback) {
    try {
        const name = context.getUserData("HUAWEI_CLOUD_USERNAME");
        const password = context.getUserData("HUAWEI_CLOUD_PASSWORD");
        const domainName = context.getUserData("HUAWEI_CLOUD_DOMAIN_NAME");

        const token = await getToken(name, password, domainName);
        const { formattedStartTime, formattedEndTime, endTimeForFileName } = getFormattedTimes();
        const logs = await fetchBackupLogs(token, formattedStartTime, formattedEndTime);

        
        const vaultEmailMap = process.env.VAULT_EMAILS ? JSON.parse(process.env.VAULT_EMAILS) : {};

        for (let vaultId in vaultEmailMap) {
            const filteredLogs = logs.filter(log => log.VaultID === vaultId);
            if (filteredLogs.length > 0) {
                const filePath = `/tmp/Backup_Reports-${vaultId}-(${endTimeForFileName}).xlsx`;
                await createFormattedExcel(filteredLogs, filePath);

                const emailResponse = await sendEmailWithReport(filePath, `Backup_Reports-${vaultId}-(${endTimeForFileName}).xlsx`, vaultEmailMap[vaultId]);
                console.log(emailResponse);
            }
        }

        callback(null, 'Reports successfully sent');
    } catch (error) {
        console.error('Operation failed:', error);
        callback(error);
    }
};

// Vault id ye gore birden cok mail hesabina mail atabilen script.