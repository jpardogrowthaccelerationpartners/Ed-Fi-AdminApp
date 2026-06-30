# SPDX-License-Identifier: Apache-2.0
# Licensed to the Ed-Fi Alliance under one or more agreements.
# The Ed-Fi Alliance licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.

<#
.SYNOPSIS
    Starts Docker Compose services for local development, selecting one or more Ed-Fi target topologies.

.EXAMPLE
    ./start-local-dev-target.ps1 -Target v6
    Starts support services and Ed-Fi v6 services.

.EXAMPLE
    ./start-local-dev-target.ps1 -Target odsV7-adminV2
    Starts support services and Ed-Fi v7 Admin API v2 services.

.EXAMPLE
    ./start-local-dev-target.ps1 -Target odsV7-adminV3 -MSSQL
    Starts support services and Ed-Fi v7 Admin API v3 services, with MSSQL for Admin App DB.

.EXAMPLE
    ./start-local-dev-target.ps1 -Target v6 -Target odsV7-adminV2
    Starts support services and both target topologies in one command.

.EXAMPLE
    ./start-local-dev-target.ps1 -V6 -OdsV7AdminV2
    Starts support services and both target topologies in one command using switches.

.EXAMPLE
    ./start-local-dev-target.ps1 -Target v6,odsV7-adminV2 -IncludeAdminApp
    Starts support services, selected targets, and Admin App API/FE containers.
#>

param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('v6', 'odsV7-adminV2', 'odsV7-adminV3')]
    [string[]]
    $Target = @(),

    # Select Ed-Fi v6 topology
    [Switch]
    $V6,

    # Select Ed-Fi v7 Admin API v2 topology
    [Switch]
    $OdsV7AdminV2,

    # Select Ed-Fi v7 Admin API v3 topology
    [Switch]
    $OdsV7AdminV3,

    # Use SQL Server instead of PostgreSQL for the Admin App database
    [Switch]
    $MSSQL,

    # Include Admin App API and FE services
    [Switch]
    $IncludeAdminApp
)

$selectedTargets = @()
foreach ($targetArg in $Target) {
    if ($null -eq $targetArg) {
        continue
    }

    $selectedTargets += @(
        $targetArg.Split(',', [System.StringSplitOptions]::RemoveEmptyEntries) |
            ForEach-Object { $_.Trim() } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
}

$allowedTargets = @('v6', 'odsV7-adminV2', 'odsV7-adminV3')
$invalidTargets = @($selectedTargets | Where-Object { $_ -notin $allowedTargets } | Select-Object -Unique)
if ($invalidTargets.Count -gt 0) {
    Write-Host "ERROR! Invalid target(s): $($invalidTargets -join ', '). Allowed values: $($allowedTargets -join ', ')." -ForegroundColor Red
    exit 1
}

if ($V6) {
    $selectedTargets += 'v6'
}
if ($OdsV7AdminV2) {
    $selectedTargets += 'odsV7-adminV2'
}
if ($OdsV7AdminV3) {
    $selectedTargets += 'odsV7-adminV3'
}

$selectedTargets = @($selectedTargets | Select-Object -Unique)
if ($selectedTargets.Count -eq 0) {
    Write-Host 'ERROR! Select at least one target using -Target or target switches (-V6, -OdsV7AdminV2, -OdsV7AdminV3).' -ForegroundColor Red
    exit 1
}

$networkExists = docker network ls --filter name=edfiadminapp-network --format '{{.Name}}' | Select-String -Pattern 'edfiadminapp-network'
if (-not $networkExists) {
    Write-Host "Creating edfiadminapp-network..." -ForegroundColor Yellow
    docker network create edfiadminapp-network --driver bridge
}

$edfiServicesFile = Join-Path $PSScriptRoot 'edfi-services.yml'
$nginxComposeFile = Join-Path $PSScriptRoot 'nginx-compose.yml'
$adminAppServicesFile = Join-Path $PSScriptRoot 'adminapp-services.yml'
$envFile = Join-Path $PSScriptRoot '.env'

$files = @(
    '-f', $edfiServicesFile,
    '-f', $nginxComposeFile,
    '-f', $adminAppServicesFile
)

$composeProfile = 'postgresql'
$adminAppDbService = 'edfiadminapp-postgres'
if ($MSSQL) {
    $composeProfile = 'mssql'
    $adminAppDbService = 'edfiadminapp-mssql'
}

$commonServices = @(
    'nginx',
    'edfiadminapp-keycloak',
    $adminAppDbService,
    'memcached',
    'yopass',
    'pgadmin4'
)

$targetServices = @()
foreach ($selectedTarget in $selectedTargets) {
    $targetServices += switch ($selectedTarget) {
        'v6' {
            @(
                'v6-db-admin',
                'v6-edfi-ods_255901',
                'v6-edfi-ods_255902',
                'v6-api',
                'v6-adminapi'
            )
        }
        'odsV7-adminV2' {
            @(
                'odsV7-adminV2-single-db-ods',
                'odsV7-adminV2-single-db-admin',
                'odsV7-adminV2-single-api',
                'odsV7-adminV2-single-adminapi',
                'odsV7-adminV2-tenant1-db-ods',
                'odsV7-adminV2-tenant2-db-ods',
                'odsV7-adminV2-tenant1-db-admin',
                'odsV7-adminV2-tenant2-db-admin',
                'odsV7-adminV2-multi-api',
                'odsV7-adminV2-multi-adminapi'
            )
        }
        'odsV7-adminV3' {
            @(
                'odsV7-adminV3-single-db-ods',
                'odsV7-adminV3-single-db-admin',
                'odsV7-adminV3-single-api',
                'odsV7-adminV3-single-adminapi',
                'odsV7-adminV3-tenant1-db-ods',
                'odsV7-adminV3-tenant2-db-ods',
                'odsV7-adminV3-tenant1-db-admin',
                'odsV7-adminV3-tenant2-db-admin',
                'odsV7-adminV3-multi-api',
                'odsV7-adminV3-multi-adminapi'
            )
        }
    }
}

$servicesToStart = @($commonServices + $targetServices | Select-Object -Unique)
$selectedTargetsText = $selectedTargets -join ', '

$composeProfiles = @($composeProfile)
if ($IncludeAdminApp) {
    $composeProfiles += 'adminapp'
    $servicesToStart += @('edfiadminapp-api', 'edfiadminapp-fe')
    $servicesToStart = @($servicesToStart | Select-Object -Unique)
}

$profileArgs = @()
foreach ($profile in $composeProfiles) {
    $profileArgs += @('--profile', $profile)
}

Write-Host "Starting Docker Compose services with profile $composeProfile for targets $selectedTargetsText..." -ForegroundColor Green
Write-Host "Services: $($servicesToStart -join ', ')" -ForegroundColor Cyan

docker compose $files --env-file $envFile $profileArgs up -d $servicesToStart

if ($LASTEXITCODE -ne 0) {
    Write-Host 'ERROR! Services failed to start.' -ForegroundColor Red
    exit 1
}

Write-Host 'Services started successfully!' -ForegroundColor Green
